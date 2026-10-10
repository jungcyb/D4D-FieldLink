################################################################################
# Automatically-generated file. Do not edit!
################################################################################

SHELL = cmd.exe

# Each subdirectory must supply rules for building sources it contributes
%.o: ../%.c $(GEN_OPTS) | $(GEN_FILES) $(GEN_MISC_FILES)
	@echo 'Arm Compiler - building file: "$<"'
	"C:/ti/ccs2101/ccs/tools/compiler/ti-cgt-armllvm_5.1.1.LTS/bin/tiarmclang.exe" -c -mcpu=cortex-r5 -mfloat-abi=hard -mfpu=vfpv3-d16 -mlittle-endian -mthumb -I"C:/ti/ccs2101/ccs/tools/compiler/ti-cgt-armllvm_5.1.1.LTS/include/c" -I"C:/ti/mcu_plus_sdk_am64x_11_02_00_24/source" -I"C:/ti/mcu_plus_sdk_am64x_11_02_00_24/source/kernel/freertos/FreeRTOS-Kernel/include" -I"C:/ti/mcu_plus_sdk_am64x_11_02_00_24/source/kernel/freertos/portable/TI_ARM_CLANG/ARM_CR5F" -I"C:/ti/mcu_plus_sdk_am64x_11_02_00_24/source/kernel/freertos/config/am64x/r5f" -DSOC_AM64X -DOS_FREERTOS -D_DEBUG_=1 -g -Wall -Werror -Wno-gnu-variable-sized-type-not-at-end -Wno-unused-function -MMD -MP -MF"$(basename $(<F)).d_raw" -MT"$(@)" -I"C:/Users/10133/Documents/contest/ads8688_am6442_sk/firmware/ipc_rpmsg_echo_am64x-sk_r5fss0-0_freertos_ti-arm-clang/Debug/syscfg"  $(GEN_OPTS__FLAG) -o"$@" "$<"
	@echo 'Finished building: "$<"'
	@echo ' '

build-316538333: ../example.syscfg
	@echo 'SysConfig - building file: "$<"'
	"C:/ti/sysconfig_1.27.0/sysconfig_cli.bat" -s "C:/ti/mcu_plus_sdk_am64x_11_02_00_24/.metadata/product.json" -p "ALV" -r "Default" --script "C:/Users/10133/Documents/contest/ads8688_am6442_sk/firmware/ipc_rpmsg_echo_am64x-sk_r5fss0-0_freertos_ti-arm-clang/example.syscfg" --context "r5fss0-0" -o "syscfg" --compiler ticlang
	@echo 'Finished building: "$<"'
	@echo ' '

syscfg/ti_dpl_config.c: build-316538333 ../example.syscfg
syscfg/ti_dpl_config.h: build-316538333
syscfg/ti_drivers_config.c: build-316538333
syscfg/ti_drivers_config.h: build-316538333
syscfg/ti_drivers_open_close.c: build-316538333
syscfg/ti_drivers_open_close.h: build-316538333
syscfg/ti_pinmux_config.c: build-316538333
syscfg/ti_power_clock_config.c: build-316538333
syscfg/ti_board_config.c: build-316538333
syscfg/ti_board_config.h: build-316538333
syscfg/ti_board_open_close.c: build-316538333
syscfg/ti_board_open_close.h: build-316538333
syscfg/ti_enet_config.c: build-316538333
syscfg/ti_enet_config.h: build-316538333
syscfg/ti_enet_init.c: build-316538333
syscfg/ti_enet_dma_init.h: build-316538333
syscfg/ti_enet_dma_init.c: build-316538333
syscfg/ti_enet_open_close.c: build-316538333
syscfg/ti_enet_open_close.h: build-316538333
syscfg/ti_enet_soc.c: build-316538333
syscfg/ti_enet_lwipif.c: build-316538333
syscfg/ti_enet_lwipif.h: build-316538333
syscfg/ti_usb_descriptor.c: build-316538333
syscfg/ti_usb_config.h: build-316538333
syscfg/linker.cmd: build-316538333
syscfg/linker_defines.h: build-316538333
syscfg: build-316538333

syscfg/%.o: ./syscfg/%.c $(GEN_OPTS) | $(GEN_FILES) $(GEN_MISC_FILES)
	@echo 'Arm Compiler - building file: "$<"'
	"C:/ti/ccs2101/ccs/tools/compiler/ti-cgt-armllvm_5.1.1.LTS/bin/tiarmclang.exe" -c -mcpu=cortex-r5 -mfloat-abi=hard -mfpu=vfpv3-d16 -mlittle-endian -mthumb -I"C:/ti/ccs2101/ccs/tools/compiler/ti-cgt-armllvm_5.1.1.LTS/include/c" -I"C:/ti/mcu_plus_sdk_am64x_11_02_00_24/source" -I"C:/ti/mcu_plus_sdk_am64x_11_02_00_24/source/kernel/freertos/FreeRTOS-Kernel/include" -I"C:/ti/mcu_plus_sdk_am64x_11_02_00_24/source/kernel/freertos/portable/TI_ARM_CLANG/ARM_CR5F" -I"C:/ti/mcu_plus_sdk_am64x_11_02_00_24/source/kernel/freertos/config/am64x/r5f" -DSOC_AM64X -DOS_FREERTOS -D_DEBUG_=1 -g -Wall -Werror -Wno-gnu-variable-sized-type-not-at-end -Wno-unused-function -MMD -MP -MF"syscfg/$(basename $(<F)).d_raw" -MT"$(@)" -I"C:/Users/10133/Documents/contest/ads8688_am6442_sk/firmware/ipc_rpmsg_echo_am64x-sk_r5fss0-0_freertos_ti-arm-clang/Debug/syscfg"  $(GEN_OPTS__FLAG) -o"$@" "$<"
	@echo 'Finished building: "$<"'
	@echo ' '


