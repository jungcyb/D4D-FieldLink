################################################################################
# Automatically-generated file. Do not edit!
################################################################################

SHELL = cmd.exe

# Add inputs and outputs from these tool invocations to the build variables 
SYSCFG_SRCS += \
../example.syscfg 

C_SRCS += \
../ads1263.c \
../ads1263_task.c \
./syscfg/ti_dpl_config.c \
./syscfg/ti_drivers_config.c \
./syscfg/ti_drivers_open_close.c \
./syscfg/ti_pinmux_config.c \
./syscfg/ti_power_clock_config.c \
./syscfg/ti_board_config.c \
./syscfg/ti_board_open_close.c \
./syscfg/ti_enet_config.c \
./syscfg/ti_enet_init.c \
./syscfg/ti_enet_dma_init.c \
./syscfg/ti_enet_open_close.c \
./syscfg/ti_enet_soc.c \
./syscfg/ti_enet_lwipif.c \
./syscfg/ti_usb_descriptor.c \
../ipc_rpmsg_echo.c \
../main.c 

GEN_CMDS += \
./syscfg/linker.cmd 

GEN_FILES += \
./syscfg/ti_dpl_config.c \
./syscfg/ti_drivers_config.c \
./syscfg/ti_drivers_open_close.c \
./syscfg/ti_pinmux_config.c \
./syscfg/ti_power_clock_config.c \
./syscfg/ti_board_config.c \
./syscfg/ti_board_open_close.c \
./syscfg/ti_enet_config.c \
./syscfg/ti_enet_init.c \
./syscfg/ti_enet_dma_init.c \
./syscfg/ti_enet_open_close.c \
./syscfg/ti_enet_soc.c \
./syscfg/ti_enet_lwipif.c \
./syscfg/ti_usb_descriptor.c \
./syscfg/linker.cmd 

GEN_MISC_DIRS += \
./syscfg 

C_DEPS += \
./ads1263.d \
./ads1263_task.d \
./syscfg/ti_dpl_config.d \
./syscfg/ti_drivers_config.d \
./syscfg/ti_drivers_open_close.d \
./syscfg/ti_pinmux_config.d \
./syscfg/ti_power_clock_config.d \
./syscfg/ti_board_config.d \
./syscfg/ti_board_open_close.d \
./syscfg/ti_enet_config.d \
./syscfg/ti_enet_init.d \
./syscfg/ti_enet_dma_init.d \
./syscfg/ti_enet_open_close.d \
./syscfg/ti_enet_soc.d \
./syscfg/ti_enet_lwipif.d \
./syscfg/ti_usb_descriptor.d \
./ipc_rpmsg_echo.d \
./main.d 

OBJS += \
./ads1263.o \
./ads1263_task.o \
./syscfg/ti_dpl_config.o \
./syscfg/ti_drivers_config.o \
./syscfg/ti_drivers_open_close.o \
./syscfg/ti_pinmux_config.o \
./syscfg/ti_power_clock_config.o \
./syscfg/ti_board_config.o \
./syscfg/ti_board_open_close.o \
./syscfg/ti_enet_config.o \
./syscfg/ti_enet_init.o \
./syscfg/ti_enet_dma_init.o \
./syscfg/ti_enet_open_close.o \
./syscfg/ti_enet_soc.o \
./syscfg/ti_enet_lwipif.o \
./syscfg/ti_usb_descriptor.o \
./ipc_rpmsg_echo.o \
./main.o 

GEN_MISC_FILES += \
./syscfg/ti_dpl_config.h \
./syscfg/ti_drivers_config.h \
./syscfg/ti_drivers_open_close.h \
./syscfg/ti_board_config.h \
./syscfg/ti_board_open_close.h \
./syscfg/ti_enet_config.h \
./syscfg/ti_enet_dma_init.h \
./syscfg/ti_enet_open_close.h \
./syscfg/ti_enet_lwipif.h \
./syscfg/ti_usb_config.h \
./syscfg/linker_defines.h 

GEN_MISC_DIRS__QUOTED += \
"syscfg" 

OBJS__QUOTED += \
"ads1263.o" \
"ads1263_task.o" \
"syscfg\ti_dpl_config.o" \
"syscfg\ti_drivers_config.o" \
"syscfg\ti_drivers_open_close.o" \
"syscfg\ti_pinmux_config.o" \
"syscfg\ti_power_clock_config.o" \
"syscfg\ti_board_config.o" \
"syscfg\ti_board_open_close.o" \
"syscfg\ti_enet_config.o" \
"syscfg\ti_enet_init.o" \
"syscfg\ti_enet_dma_init.o" \
"syscfg\ti_enet_open_close.o" \
"syscfg\ti_enet_soc.o" \
"syscfg\ti_enet_lwipif.o" \
"syscfg\ti_usb_descriptor.o" \
"ipc_rpmsg_echo.o" \
"main.o" 

GEN_MISC_FILES__QUOTED += \
"syscfg\ti_dpl_config.h" \
"syscfg\ti_drivers_config.h" \
"syscfg\ti_drivers_open_close.h" \
"syscfg\ti_board_config.h" \
"syscfg\ti_board_open_close.h" \
"syscfg\ti_enet_config.h" \
"syscfg\ti_enet_dma_init.h" \
"syscfg\ti_enet_open_close.h" \
"syscfg\ti_enet_lwipif.h" \
"syscfg\ti_usb_config.h" \
"syscfg\linker_defines.h" 

C_DEPS__QUOTED += \
"ads1263.d" \
"ads1263_task.d" \
"syscfg\ti_dpl_config.d" \
"syscfg\ti_drivers_config.d" \
"syscfg\ti_drivers_open_close.d" \
"syscfg\ti_pinmux_config.d" \
"syscfg\ti_power_clock_config.d" \
"syscfg\ti_board_config.d" \
"syscfg\ti_board_open_close.d" \
"syscfg\ti_enet_config.d" \
"syscfg\ti_enet_init.d" \
"syscfg\ti_enet_dma_init.d" \
"syscfg\ti_enet_open_close.d" \
"syscfg\ti_enet_soc.d" \
"syscfg\ti_enet_lwipif.d" \
"syscfg\ti_usb_descriptor.d" \
"ipc_rpmsg_echo.d" \
"main.d" 

GEN_FILES__QUOTED += \
"syscfg\ti_dpl_config.c" \
"syscfg\ti_drivers_config.c" \
"syscfg\ti_drivers_open_close.c" \
"syscfg\ti_pinmux_config.c" \
"syscfg\ti_power_clock_config.c" \
"syscfg\ti_board_config.c" \
"syscfg\ti_board_open_close.c" \
"syscfg\ti_enet_config.c" \
"syscfg\ti_enet_init.c" \
"syscfg\ti_enet_dma_init.c" \
"syscfg\ti_enet_open_close.c" \
"syscfg\ti_enet_soc.c" \
"syscfg\ti_enet_lwipif.c" \
"syscfg\ti_usb_descriptor.c" \
"syscfg\linker.cmd" 

C_SRCS__QUOTED += \
"../ads1263.c" \
"../ads1263_task.c" \
"./syscfg/ti_dpl_config.c" \
"./syscfg/ti_drivers_config.c" \
"./syscfg/ti_drivers_open_close.c" \
"./syscfg/ti_pinmux_config.c" \
"./syscfg/ti_power_clock_config.c" \
"./syscfg/ti_board_config.c" \
"./syscfg/ti_board_open_close.c" \
"./syscfg/ti_enet_config.c" \
"./syscfg/ti_enet_init.c" \
"./syscfg/ti_enet_dma_init.c" \
"./syscfg/ti_enet_open_close.c" \
"./syscfg/ti_enet_soc.c" \
"./syscfg/ti_enet_lwipif.c" \
"./syscfg/ti_usb_descriptor.c" \
"../ipc_rpmsg_echo.c" \
"../main.c" 

SYSCFG_SRCS__QUOTED += \
"../example.syscfg" 


