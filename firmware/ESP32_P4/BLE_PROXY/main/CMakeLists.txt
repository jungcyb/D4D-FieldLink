idf_component_register(SRCS "main.c" "eth.c" "fl_link.c" "daq_server.c" "wifi_uplink.c"
                       INCLUDE_DIRS "." "../../../common"
                       REQUIRES ble_uart nvs_flash esp_netif esp_eth esp_event
                                esp_timer lwip esp_wifi)
