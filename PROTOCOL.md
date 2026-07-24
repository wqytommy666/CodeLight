# Colorful Lights / JTX-RGB 通信记录

## 设备识别

- 产品：Voice Controlled Music Lamp / NewUpgrade 拾音节奏灯
- 二维码：`http://www.qrtransfer.com/Colorful_Lights.html`
- App：Colorful Lights 1.1.1
- Android APK：`https://lenze-android-beta.oss-cn-shenzhen.aliyuncs.com/拾音灯/Colorful_Lights_1.1.1.apk`
- APK SHA-256：`6e7071e9e84cc64a41d3e4901e0d7e8be6312fe0ccb69432be0dcc41ccc540f3`
- BLE 广播名：`JTX-RGB`
- BLE 广播 Service UUID：`2022`
- 本机 CoreBluetooth peripheral UUID：`960ACC6B-B7EB-F4A1-94E1-940DC59137C1`
- 设备公开地址：`FF:25:03:13:33:FD`

初次扫描的 manufacturer data 为 `ffffff25031333fd66ff030400`，其中包含公开地址，已确认本机 UUID 对应的是用户这台灯。

## 已实测 GATT

```text
SERVICE FFF0
  CHAR FFF3  write, writeWithoutResponse
  CHAR FFF4  notify

SERVICE 5833FF01-9B8B-5191-6142-22A4536EF123
  CHAR 5833FF02-9B8B-5191-6142-22A4536EF123  write
  CHAR 5833FF03-9B8B-5191-6142-22A4536EF123  notify
```

Colorful Lights Android App 反编译确认业务通道为 `FFF0/FFF3`。它使用 BLE GATT，不是蓝牙串口、Wi-Fi 或云端 API，也不要求系统配对码。

## 已实机验证的帧

帧结构：

```text
BC <command> <payload-length> <payload...> 55
```

- 开灯：`BC 01 01 01 55`
- 关灯：`BC 01 01 00 55`
- 红：`BC 04 06 00 00 03 E8 00 00 55`
- 黄：`BC 04 06 00 3C 03 E8 00 00 55`
- 绿：`BC 04 06 00 78 03 E8 00 00 55`
- 蓝：`BC 04 06 00 F0 03 E8 00 00 55`
- 最大亮度：`BC 05 06 03 E8 00 00 00 00 55`
- 零亮度：`BC 05 06 00 00 00 00 00 00 55`

颜色帧采用 HSV：色相和 `saturation × 1000` 都是大端 `UInt16`。这版固件在 GATT 特征发现完成后还要等待约 1.5 秒，应用命令解析器才会真正响应。

2026-07-24 已实机验证开、关、红、黄、绿、蓝以及连续闪烁。状态爆闪使用零亮度遮黑而不再反复开关电源，避免充电渲染器在开灯瞬间夹入白光；有色状态每 0.6 秒重申静态颜色，防止固件重新接管后丢失常亮。

## 充电四格动画

产品说明将电源键短按定义为“显示电量”，四格绿色表示 75%–100%。Colorful Lights 1.1.1 APK 的全部应用层写帧中没有“关闭充电动画”或“充电指示设置”命令；它属于灯具 MCU 固件行为，而不是 App 设置。

APK 的亮度滑杆把最小值强制限制为 `3`，但 `05` 命令的字段本身可以编码 `0`。当前后台控制器采用 `关灯 + 零亮度`，空闲时每秒低频重申零亮度；相比高频重发关灯帧，不会人为制造开关闪烁。可用 `agent-light-hook charger-silence on|off` 切换。

APK 中应用层可见的 `BC` 命令族为：`01` 电源、`04` HSV 颜色、`05` 亮度、`06` 模式、`08/16` 模式参数、`09` 音乐颜色、`15/17/18` 麦克风参数；未发现充电指示命令。
