"""BlueZ Nordic UART peripheral for the existing NU40 central firmware.

Run inside ads8688d on Linux. Missing BlueZ/adapter is a visible source error,
never a reason to stop ADS8688. dbus-next is the only additional dependency.
"""
import asyncio
import queue
import socket
import threading
import time

try:
    from .nu40 import Link
except ImportError:
    from nu40 import Link


class Receiver:
    def __init__(self, identity):
        self.identity = identity
        self.events = queue.Queue(maxsize=128)
        self.commands = queue.Queue(maxsize=16)
        self.reader, self.writer = socket.socketpair()
        self.reader.setblocking(False)
        self.writer.setblocking(False)
        self.stopping = threading.Event()
        self.dropped_batches = 0

    def emit(self, event):
        try:
            self.events.put_nowait(event)
        except queue.Full:
            self.dropped_batches += 1  # sequence discontinuity remains visible downstream
            return
        try:
            self.writer.send(b'1')
        except BlockingIOError:
            pass

    def drain(self):
        try:
            self.reader.recv(4096)
        except BlockingIOError:
            pass
        while True:
            try:
                yield self.events.get_nowait()
            except queue.Empty:
                return

    def start(self):
        self.thread = threading.Thread(target=self.run, name='nu40-bluez', daemon=True)
        self.thread.start()

    def run(self):
        while not self.stopping.is_set():
            try:
                asyncio.run(self.serve())
            except Exception as error:
                self.emit({'status': {'state': 'unavailable', 'error': str(error), 'rate_hz': 104}})
                self.stopping.wait(5)

    def close(self):
        self.stopping.set()
        self.thread.join(timeout=3)
        if not self.thread.is_alive():
            self.reader.close()
            self.writer.close()

    async def serve(self):
        from dbus_next import BusType, PropertyAccess, Variant, DBusError
        from dbus_next.aio import MessageBus
        from dbus_next.service import ServiceInterface, method, dbus_property

        root = '/com/fieldlink/nu40'
        service_path = root + '/service0'
        uuid_base = '-b5a3-f393-e0a9-e50e24dcca9e'
        bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        receiver = self
        peer = None
        gatt_manager = advertising_manager = None
        registered = False

        class Service(ServiceInterface):
            def __init__(self):
                super().__init__('org.bluez.GattService1')

            @dbus_property(access=PropertyAccess.READ)
            def UUID(self) -> 's':
                return '6e400001' + uuid_base

            @dbus_property(access=PropertyAccess.READ)
            def Primary(self) -> 'b':
                return True

        class Characteristic(ServiceInterface):
            def __init__(self, tx):
                super().__init__('org.bluez.GattCharacteristic1')
                self.tx, self.notifying = tx, False
                self.value = b''

            @dbus_property(access=PropertyAccess.READ)
            def UUID(self) -> 's':
                return ('6e400003' if self.tx else '6e400002') + uuid_base

            @dbus_property(access=PropertyAccess.READ)
            def Service(self) -> 'o':
                return service_path

            @dbus_property(access=PropertyAccess.READ)
            def Flags(self) -> 'as':
                return ['notify'] if self.tx else ['write', 'write-without-response']

            @dbus_property(access=PropertyAccess.READ)
            def Value(self) -> 'ay':
                return self.value

            @dbus_property(access=PropertyAccess.READ)
            def Notifying(self) -> 'b':
                return self.notifying

            @method()
            def WriteValue(self, value: 'ay', options: 'a{sv}'):
                nonlocal peer
                device = options.get('device')
                if self.tx or not device or peer not in (None, device.value):
                    raise DBusError('org.bluez.Error.NotPermitted', 'one NU40 per DAQ')
                peer = device.value
                link.receive(bytes(value))

            @method()
            def StartNotify(self):
                if not self.tx:
                    raise DBusError('org.bluez.Error.NotSupported', 'RX is not notify')
                self.notifying = True
                self.emit_properties_changed({'Notifying': True})

            @method()
            def StopNotify(self):
                nonlocal peer
                self.notifying = False
                peer = None
                link.reset()
                receiver.emit({'status': link.status()})
                self.emit_properties_changed({'Notifying': False})

        tx, rx, service = Characteristic(True), Characteristic(False), Service()

        def send(data):
            if not tx.notifying:
                raise RuntimeError('NU40 has not subscribed to TX')
            # Control only: 20-byte chunks also work before MTU negotiation completes.
            for start in range(0, len(data), 20):
                tx.value = data[start:start + 20]
                tx.emit_properties_changed({'Value': tx.value})

        link = Link(send, self.emit, self.identity.bytes[:8])

        class Advertisement(ServiceInterface):
            def __init__(self):
                super().__init__('org.bluez.LEAdvertisement1')

            @dbus_property(access=PropertyAccess.READ)
            def Type(self) -> 's':
                return 'peripheral'

            @dbus_property(access=PropertyAccess.READ)
            def ServiceUUIDs(self) -> 'as':
                return ['6e400001' + uuid_base]

            @dbus_property(access=PropertyAccess.READ)
            def LocalName(self) -> 's':
                return 'FL-AM64'

            @method()
            def Release(self):
                receiver.emit({'status': {'state': 'unavailable', 'error': 'BLE advertisement released'}})

        # dbus-next exports ObjectManager automatically for exported objects.
        bus.export(service_path, service)
        bus.export(service_path + '/rx', rx)
        bus.export(service_path + '/tx', tx)
        bus.export('/com/fieldlink/advertisement', Advertisement())
        try:
            manager = bus.get_proxy_object('org.bluez', '/', await bus.introspect('org.bluez', '/')).get_interface('org.freedesktop.DBus.ObjectManager')
            objects = await manager.call_get_managed_objects()
            adapter_path = next((p for p, interfaces in objects.items() if 'org.bluez.GattManager1' in interfaces and 'org.bluez.LEAdvertisingManager1' in interfaces), None)
            if not adapter_path:
                raise RuntimeError('No BlueZ adapter supporting GATT peripheral + LE advertising')
            adapter = bus.get_proxy_object('org.bluez', adapter_path, await bus.introspect('org.bluez', adapter_path))
            await adapter.get_interface('org.freedesktop.DBus.Properties').call_set('org.bluez.Adapter1', 'Powered', Variant('b', True))
            gatt_manager = adapter.get_interface('org.bluez.GattManager1')
            advertising_manager = adapter.get_interface('org.bluez.LEAdvertisingManager1')
            await gatt_manager.call_register_application(root, {})
            await advertising_manager.call_register_advertisement('/com/fieldlink/advertisement', {})
            registered = True
            last_status = 0
            while not self.stopping.is_set():
                if link.last_rx and time.monotonic() - link.last_rx > 5:
                    if peer:
                        device = bus.get_proxy_object('org.bluez', peer, await bus.introspect('org.bluez', peer))
                        await device.get_interface('org.bluez.Device1').call_disconnect()
                    peer = None
                    link.reset()
                try:
                    command = self.commands.get_nowait()
                    link.wanted = command['acquiring']
                    if link.state in ('streaming', 'stopped'):
                        link.send_control(0x22 if link.wanted else 0x23)
                except queue.Empty:
                    pass
                if time.monotonic() - last_status >= 1:
                    self.emit({'status': {**link.status(), 'dropped_batches': self.dropped_batches}})
                    last_status = time.monotonic()
                await asyncio.sleep(.01)
        finally:
            if registered:
                try:
                    await advertising_manager.call_unregister_advertisement('/com/fieldlink/advertisement')
                    await gatt_manager.call_unregister_application(root)
                except Exception:
                    pass  # BlueZ restart already removes owner-scoped registrations.
            bus.disconnect()
