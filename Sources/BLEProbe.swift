import Foundation
import CoreBluetooth

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

func characteristicPropertyNames(_ properties: CBCharacteristicProperties) -> String {
    var names: [String] = []
    if properties.contains(.broadcast) { names.append("broadcast") }
    if properties.contains(.read) { names.append("read") }
    if properties.contains(.writeWithoutResponse) { names.append("writeWithoutResponse") }
    if properties.contains(.write) { names.append("write") }
    if properties.contains(.notify) { names.append("notify") }
    if properties.contains(.indicate) { names.append("indicate") }
    if properties.contains(.authenticatedSignedWrites) { names.append("signedWrite") }
    if properties.contains(.extendedProperties) { names.append("extended") }
    if properties.contains(.notifyEncryptionRequired) { names.append("notifyEncryptionRequired") }
    if properties.contains(.indicateEncryptionRequired) { names.append("indicateEncryptionRequired") }
    return names.joined(separator: ",")
}

struct Advertisement {
    let identifier: UUID
    let name: String
    let rssi: Int
    let connectable: Bool?
    let serviceUUIDs: [String]
    let manufacturerData: String
}

enum Operation {
    case scan(seconds: Double)
    case probe(target: String, holdSeconds: Double)
}

final class BLEProbe: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private let operation: Operation
    private var advertisements: [UUID: Advertisement] = [:]
    private var target: CBPeripheral?
    private var serviceCount = 0
    private var characteristicCallbackCount = 0
    private var finishScheduled = false

    init(operation: Operation) {
        self.operation = operation
        super.init()
        central = CBCentralManager(
            delegate: self,
            queue: nil,
            options: [CBCentralManagerOptionShowPowerAlertKey: true]
        )
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            print("ERROR Bluetooth unavailable, CoreBluetooth state=\(central.state.rawValue)")
            if central.state == .unsupported || central.state == .unauthorized || central.state == .poweredOff {
                exit(2)
            }
            return
        }

        switch operation {
        case .scan(let seconds):
            print("Scanning BLE devices for \(Int(seconds)) seconds...")
            central.scanForPeripherals(withServices: nil, options: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
                self?.finishScan()
            }

        case .probe(let match, _):
            if let identifier = UUID(uuidString: match),
               let remembered = central.retrievePeripherals(withIdentifiers: [identifier]).first {
                print("RETRIEVED id=\(remembered.identifier.uuidString) name=\(remembered.name ?? "")")
                connect(to: remembered)
            } else {
                print("Scanning for target \(match)...")
                central.scanForPeripherals(withServices: nil, options: nil)
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
                guard let self, !self.finishScheduled else { return }
                print("ERROR target connection/probe timed out")
                exit(3)
            }
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = advertisedName ?? peripheral.name ?? "(unnamed)"
        let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? [])
            .map(\.uuidString)
        let manufacturerData = (advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data)?.hex ?? ""
        let connectable = (advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue

        advertisements[peripheral.identifier] = Advertisement(
            identifier: peripheral.identifier,
            name: name,
            rssi: RSSI.intValue,
            connectable: connectable,
            serviceUUIDs: services,
            manufacturerData: manufacturerData
        )

        guard case .probe(let match, _) = operation else { return }
        if name.localizedCaseInsensitiveContains(match)
            || peripheral.identifier.uuidString.caseInsensitiveCompare(match) == .orderedSame {
            print("FOUND name=\(name) id=\(peripheral.identifier.uuidString) RSSI=\(RSSI)")
            connect(to: peripheral)
        }
    }

    private func connect(to peripheral: CBPeripheral) {
        guard target == nil else { return }
        target = peripheral
        central.stopScan()
        peripheral.delegate = self
        print("Connecting...")
        central.connect(
            peripheral,
            options: [CBConnectPeripheralOptionNotifyOnDisconnectionKey: true]
        )
    }

    private func finishScan() {
        central.stopScan()
        let rows = advertisements.values.sorted {
            if $0.rssi == $1.rssi { return $0.name < $1.name }
            return $0.rssi > $1.rssi
        }
        print("\nBLE devices: \(rows.count)")
        for row in rows where row.name != "(unnamed)" || row.connectable == true {
            print(
                "RSSI \(String(format: "%4d", row.rssi)) | \(row.name)"
                    + " | id=\(row.identifier.uuidString)"
                    + " | connectable=\(row.connectable.map(String.init) ?? "?")"
                    + " | services=\(row.serviceUUIDs.joined(separator: ","))"
                    + " | mfg=\(row.manufacturerData)"
            )
        }
        exit(0)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        print("CONNECTED name=\(peripheral.name ?? "") id=\(peripheral.identifier.uuidString)")
        peripheral.discoverServices(nil)
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        print("ERROR failed to connect: \(error?.localizedDescription ?? "unknown")")
        exit(4)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        timestamp: CFAbsoluteTime,
        isReconnecting: Bool,
        error: Error?
    ) {
        print("DISCONNECTED error=\(error?.localizedDescription ?? "none")")
        if !finishScheduled { exit(5) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error {
            print("ERROR service discovery: \(error.localizedDescription)")
            exit(6)
        }
        let services = peripheral.services ?? []
        serviceCount = services.count
        print("SERVICES count=\(services.count)")
        if services.isEmpty { scheduleFinish() }
        for service in services {
            print("  SERVICE \(service.uuid.uuidString) primary=\(service.isPrimary)")
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        characteristicCallbackCount += 1
        if let error {
            print("  ERROR characteristic discovery \(service.uuid.uuidString): \(error.localizedDescription)")
        }
        for characteristic in service.characteristics ?? [] {
            print(
                "    CHAR \(characteristic.uuid.uuidString)"
                    + " props=[\(characteristicPropertyNames(characteristic.properties))]"
            )
            peripheral.discoverDescriptors(for: characteristic)
            if characteristic.properties.contains(.read) {
                peripheral.readValue(for: characteristic)
            }
        }
        if characteristicCallbackCount >= serviceCount { scheduleFinish() }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverDescriptorsFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        let descriptors = (characteristic.descriptors ?? []).map { $0.uuid.uuidString }
        if !descriptors.isEmpty {
            print("      DESCRIPTORS \(descriptors.joined(separator: ","))")
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error {
            print("    READ \(characteristic.uuid.uuidString) ERROR=\(error.localizedDescription)")
        } else {
            print("    READ \(characteristic.uuid.uuidString) value=\(characteristic.value?.hex ?? "")")
        }
    }

    private func scheduleFinish() {
        guard !finishScheduled else { return }
        finishScheduled = true
        let holdSeconds: Double
        if case .probe(_, let seconds) = operation { holdSeconds = seconds } else { holdSeconds = 0 }
        let delay = max(2, holdSeconds)
        print("GATT enumeration complete; keeping connection for \(Int(delay)) seconds...")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let peripheral = self.target else { exit(0) }
            print("PROBE_OK")
            self.central.cancelPeripheralConnection(peripheral)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
        }
    }
}

func usage() -> Never {
    print("""
    Usage:
      ble-probe scan [seconds]
      ble-probe probe <name-or-macOS-peripheral-UUID> [hold-seconds]
    """)
    exit(64)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else { usage() }

let operation: Operation
switch command {
case "scan":
    let seconds = arguments.count > 1 ? Double(arguments[1]) ?? 12 : 12
    operation = .scan(seconds: seconds)
case "probe":
    guard arguments.count > 1 else { usage() }
    let holdSeconds = arguments.count > 2 ? Double(arguments[2]) ?? 2 : 2
    operation = .probe(target: arguments[1], holdSeconds: holdSeconds)
default:
    usage()
}

let probe = BLEProbe(operation: operation)
RunLoop.main.run()
