import Foundation
import CoreBluetooth

extension Data {
    var hexString: String { map { String(format: "%02X", $0) }.joined(separator: " ") }
}

struct WriteStep {
    let label: String
    let bytes: [UInt8]
    let delayAfter: Double
}

enum NamedColor: String {
    case red, yellow, green, blue

    var hue: UInt16 {
        switch self {
        case .red: return 0
        case .yellow: return 60
        case .green: return 120
        case .blue: return 240
        }
    }

    var chineseName: String {
        switch self {
        case .red: return "红"
        case .yellow: return "黄"
        case .green: return "绿"
        case .blue: return "蓝"
        }
    }
}

func colorFrame(_ color: NamedColor) -> [UInt8] {
    // Colorful Lights uses HSV: hue as big-endian UInt16 and saturation * 1000.
    let hue = color.hue
    let saturation: UInt16 = 1000
    return [
        0xBC, 0x04, 0x06,
        UInt8(hue >> 8), UInt8(hue & 0xFF),
        UInt8(saturation >> 8), UInt8(saturation & 0xFF),
        0x00, 0x00, 0x55,
    ]
}

let powerOnFrame: [UInt8] = [0xBC, 0x01, 0x01, 0x01, 0x55]
let powerOffFrame: [UInt8] = [0xBC, 0x01, 0x01, 0x00, 0x55]

func makeSteps(command: String, arguments: [String]) -> [WriteStep]? {
    if let color = NamedColor(rawValue: command) {
        return [
            WriteStep(label: "开机", bytes: powerOnFrame, delayAfter: 0.15),
            WriteStep(label: "设置\(color.chineseName)色", bytes: colorFrame(color), delayAfter: 0.4),
        ]
    }

    switch command {
    case "on":
        return [WriteStep(label: "开机", bytes: powerOnFrame, delayAfter: 0.3)]
    case "off":
        return [WriteStep(label: "关机", bytes: powerOffFrame, delayAfter: 0.3)]
    case "test":
        return [
            WriteStep(label: "开机", bytes: powerOnFrame, delayAfter: 0.2),
            WriteStep(label: "红色", bytes: colorFrame(.red), delayAfter: 1.2),
            WriteStep(label: "黄色", bytes: colorFrame(.yellow), delayAfter: 1.2),
            WriteStep(label: "蓝色", bytes: colorFrame(.blue), delayAfter: 1.2),
            WriteStep(label: "绿色（最终状态）", bytes: colorFrame(.green), delayAfter: 0.5),
        ]
    case "blink":
        guard let first = arguments.first, let color = NamedColor(rawValue: first) else { return nil }
        let count = arguments.count > 1 ? max(1, Int(arguments[1]) ?? 3) : 3
        let interval = arguments.count > 2 ? max(0.1, Double(arguments[2]) ?? 0.4) : 0.4
        var steps: [WriteStep] = []
        for index in 1...count {
            steps.append(WriteStep(label: "点亮 \(index)/\(count)", bytes: powerOnFrame, delayAfter: 0.08))
            steps.append(WriteStep(label: "\(color.chineseName)色闪烁 \(index)/\(count)", bytes: colorFrame(color), delayAfter: interval))
            steps.append(WriteStep(label: "熄灭 \(index)/\(count)", bytes: powerOffFrame, delayAfter: interval))
        }
        return steps
    case "raw", "raw-nr", "raw-seq", "raw-seq-nr":
        let packetStrings: [String]
        if command.hasPrefix("raw-seq") {
            packetStrings = arguments
        } else {
            packetStrings = [arguments.joined()]
        }
        guard !packetStrings.isEmpty else { return nil }
        var rawSteps: [WriteStep] = []
        for (packetIndex, packetString) in packetStrings.enumerated() {
            let joined = packetString.replacingOccurrences(of: " ", with: "")
            guard joined.count.isMultiple(of: 2), !joined.isEmpty else { return nil }
            var bytes: [UInt8] = []
            var index = joined.startIndex
            while index < joined.endIndex {
                let next = joined.index(index, offsetBy: 2)
                guard let byte = UInt8(joined[index..<next], radix: 16) else { return nil }
                bytes.append(byte)
                index = next
            }
            rawSteps.append(WriteStep(label: "RAW \(packetIndex + 1)", bytes: bytes, delayAfter: 0.6))
        }
        return rawSteps
    default:
        return nil
    }
}

final class LightController: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private let identifier: UUID
    private var steps: [WriteStep]
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var stepIndex = 0
    private var completed = false
    private let writeWithoutResponse: Bool

    init(identifier: UUID, steps: [WriteStep], writeWithoutResponse: Bool) {
        self.identifier = identifier
        self.steps = steps
        self.writeWithoutResponse = writeWithoutResponse
        super.init()
        central = CBCentralManager(
            delegate: self,
            queue: nil,
            options: [CBCentralManagerOptionShowPowerAlertKey: true]
        )
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self, !self.completed else { return }
            print("ERROR 操作超时")
            exit(2)
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            if central.state == .unsupported || central.state == .unauthorized || central.state == .poweredOff {
                print("ERROR Bluetooth 不可用，state=\(central.state.rawValue)")
                exit(3)
            }
            return
        }
        guard let found = central.retrievePeripherals(withIdentifiers: [identifier]).first else {
            print("ERROR 找不到已保存的 BLE 设备 \(identifier.uuidString)")
            exit(4)
        }
        peripheral = found
        found.delegate = self
        print("连接 \(found.name ?? "JTX-RGB") [\(identifier.uuidString)]...")
        central.connect(found, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        print("CONNECTED")
        peripheral.discoverServices([CBUUID(string: "FFF0")])
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        print("ERROR 连接失败：\(error?.localizedDescription ?? "unknown")")
        exit(5)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error {
            print("ERROR 服务发现失败：\(error.localizedDescription)")
            exit(6)
        }
        guard let service = peripheral.services?.first(where: { $0.uuid == CBUUID(string: "FFF0") }) else {
            print("ERROR 未发现 FFF0 服务")
            exit(7)
        }
        peripheral.discoverCharacteristics([CBUUID(string: "FFF3")], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        if let error {
            print("ERROR 特征发现失败：\(error.localizedDescription)")
            exit(8)
        }
        guard let characteristic = service.characteristics?.first(where: { $0.uuid == CBUUID(string: "FFF3") }) else {
            print("ERROR 未发现 FFF3 写入特征")
            exit(9)
        }
        writeCharacteristic = characteristic
        print("CONTROL_CHANNEL FFF0/FFF3 READY")
        // Some JTX-RGB firmware revisions acknowledge GATT writes before their
        // application command parser has finished initializing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.writeNext()
        }
    }

    private func writeNext() {
        guard stepIndex < steps.count else {
            completed = true
            print("CONTROL_OK 共写入 \(steps.count) 帧")
            if let peripheral { central.cancelPeripheralConnection(peripheral) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
            return
        }
        guard let peripheral, let characteristic = writeCharacteristic else { return }
        let step = steps[stepIndex]
        let typeName = writeWithoutResponse ? "withoutResponse" : "withResponse"
        print("WRITE[\(typeName)] \(stepIndex + 1)/\(steps.count) \(step.label): \(Data(step.bytes).hexString)")
        peripheral.writeValue(
            Data(step.bytes),
            for: characteristic,
            type: writeWithoutResponse ? .withoutResponse : .withResponse
        )
        if writeWithoutResponse {
            stepIndex += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + step.delayAfter) { [weak self] in
                self?.writeNext()
            }
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error {
            print("ERROR 写入失败：\(error.localizedDescription)")
            exit(10)
        }
        let delay = steps[stepIndex].delayAfter
        stepIndex += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.writeNext()
        }
    }
}

func usage() -> Never {
    print("""
    Usage: light-control <device-uuid> <command>

    Commands:
      red | yellow | green | blue
      on | off | test
      blink <red|yellow|green|blue> [count] [interval-seconds]
      raw <hex-bytes>
      raw-nr <hex-bytes>   # write without response
      raw-seq <hex-packet> [hex-packet ...]
    """)
    exit(64)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2,
      let identifier = UUID(uuidString: arguments[0]),
      let steps = makeSteps(command: arguments[1], arguments: Array(arguments.dropFirst(2))) else {
    usage()
}

let controller = LightController(
    identifier: identifier,
    steps: steps,
    writeWithoutResponse: arguments[1] == "raw-nr" || arguments[1] == "raw-seq-nr"
)
RunLoop.main.run()
