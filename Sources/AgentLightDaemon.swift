import Foundation
import CoreBluetooth
import Network
import Darwin

private let defaultPort: UInt16 = 48733
private let serviceUUID = CBUUID(string: "FFF0")
private let writeUUID = CBUUID(string: "FFF3")
private let advertisedUUID = CBUUID(string: "2022")

private extension Data {
    var hexString: String { map { String(format: "%02X", $0) }.joined(separator: " ") }
}

private func log(_ message: String) {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let line = "\(formatter.string(from: Date())) \(message)\n"
    FileHandle.standardOutput.write(Data(line.utf8))
}

private enum LightState: String, Codable {
    case off, green, blue, yellow, red

    var priority: Int {
        switch self {
        case .off: return 0
        case .green: return 1
        case .blue: return 2
        case .yellow: return 3
        case .red: return 4
        }
    }

    var hue: UInt16 {
        switch self {
        case .off, .red: return 0
        case .yellow: return 60
        case .green: return 120
        case .blue: return 240
        }
    }
}

private struct StatusEntry {
    let state: LightState
    let updatedAt: Date
    let expiresAt: Date
}

private struct DiscoveredDevice: Codable {
    let id: String
    let name: String
    let rssi: Int
}

private let powerOnFrame: [UInt8] = [0xBC, 0x01, 0x01, 0x01, 0x55]
private let powerOffFrame: [UInt8] = [0xBC, 0x01, 0x01, 0x00, 0x55]
private let maxBrightnessFrame: [UInt8] = [0xBC, 0x05, 0x06, 0x03, 0xE8, 0x00, 0x00, 0x00, 0x00, 0x55]
private let zeroBrightnessFrame: [UInt8] = [0xBC, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x55]
// Mode 147 is the firmware's full-strip/static renderer. Newer units can
// retain their factory flowing renderer even after receiving command 04.
// Selecting this mode while brightness is zero makes subsequent HSV colors
// fill the complete strip without exposing the mode's red default color.
private let staticModeFrame: [UInt8] = [0xBC, 0x06, 0x02, 0x00, 0x93, 0x55]

private func colorFrame(_ state: LightState) -> [UInt8] {
    let hue = state.hue
    let saturation: UInt16 = 1000
    return [
        0xBC, 0x04, 0x06,
        UInt8(hue >> 8), UInt8(hue & 0xFF),
        UInt8(saturation >> 8), UInt8(saturation & 0xFF),
        0x00, 0x00, 0x55,
    ]
}

private final class CommandServer {
    private let listener: NWListener
    private var connections: [UUID: NWConnection] = [:]
    private let handler: (String) -> String

    init(port: UInt16, handler: @escaping (String) -> String) throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(
            host: NWEndpoint.Host("127.0.0.1"),
            port: NWEndpoint.Port(rawValue: port)!
        )
        listener = try NWListener(using: parameters)
        self.handler = handler
    }

    func start() {
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                log("COMMAND_SERVER_READY")
            case .failed(let error):
                log("COMMAND_SERVER_FAILED \(error)")
                exit(20)
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: .main)
    }

    private func accept(_ connection: NWConnection) {
        let id = UUID()
        connections[id] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            if case .failed = state {
                connection?.cancel()
                self?.connections.removeValue(forKey: id)
            }
        }
        connection.start(queue: .main)
        receive(connection, id: id, buffer: Data())
    }

    private func receive(_ connection: NWConnection, id: UUID, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var accumulated = buffer
            if let data { accumulated.append(data) }

            if accumulated.contains(0x0A) || isComplete || error != nil || accumulated.count >= 16_384 {
                let line = String(decoding: accumulated.prefix { $0 != 0x0A && $0 != 0x0D }, as: UTF8.self)
                let response = self.handler(line) + "\n"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] _ in
                    connection.cancel()
                    self?.connections.removeValue(forKey: id)
                })
                return
            }

            self.receive(connection, id: id, buffer: accumulated)
        }
    }
}

private final class AgentLightDaemon: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private let identifier: UUID
    private let port: UInt16
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var commandServer: CommandServer?
    private var ready = false
    private var reconnectPending = false
    private var connectionGeneration: UInt64 = 0
    private var entries: [String: StatusEntry] = [:]
    private var displayedState: LightState = .off
    private var animationGeneration: UInt64 = 0
    private var chargingSilenceEnabled = true
    private var chargingPreviewGeneration: UInt64 = 0
    private var scheduledDemoGeneration: UInt64 = 0
    private var preparedDemoState: LightState?
    private var manualScanGeneration: UInt64 = 0
    private var manualScanActive = false
    private var discoveredDevices: [UUID: DiscoveredDevice] = [:]
    private var shuttingDown = false
    private var terminationSource: DispatchSourceSignal?

    init(identifier: UUID, port: UInt16) {
        self.identifier = identifier
        self.port = port
        super.init()
    }

    func start() throws {
        commandServer = try CommandServer(port: port) { [weak self] line in
            self?.handleCommand(line) ?? "ERR daemon unavailable"
        }
        commandServer?.start()

        central = CBCentralManager(
            delegate: self,
            queue: .main,
            options: [CBCentralManagerOptionShowPowerAlertKey: false]
        )

        // A light can only maintain one central connection. This firmware does
        // not resume advertising after a normal CoreBluetooth cancellation, but
        // it does when the owning central process exits and macOS releases the
        // link. Handle SIGTERM so we can blank the LEDs and then exit cleanly
        // without issuing cancelPeripheralConnection.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { [weak self] in self?.releaseBluetoothAndExit(after: 0.12) }
        source.resume()
        terminationSource = source

        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.pruneExpiredEntries()
        }
        // The charging renderer can reclaim the LEDs after a static-color
        // command. Reassert the selected color while active; while idle,
        // reassert zero brightness. Neither path toggles power, so the firmware
        // cannot leak its white/charging frame between our flashes.
        Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            guard let self else { return }
            if let prepared = self.preparedDemoState {
                self.send(colorFrame(prepared), quiet: true)
            } else if self.displayedState == .off {
                if self.chargingSilenceEnabled { self.send(zeroBrightnessFrame, quiet: true) }
            } else {
                self.send(colorFrame(self.displayedState), quiet: true)
            }
        }
        log("DAEMON_START uuid=\(identifier.uuidString) port=\(port)")
    }

    private func handleCommand(_ rawLine: String) -> String {
        let parts = rawLine.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let verb = parts.first?.lowercased() else { return "ERR empty command" }
        if preparedDemoState != nil && !["ping", "status", "scan", "devices", "demo-at"].contains(verb) {
            scheduledDemoGeneration &+= 1
            preparedDemoState = nil
        }

        switch verb {
        case "ping":
            return "OK pong"
        case "status":
            let active = entries
                .sorted { $0.value.updatedAt > $1.value.updatedAt }
                .map { "\($0.key)=\($0.value.state.rawValue)@\(Int($0.value.expiresAt.timeIntervalSince1970))" }
                .joined(separator: ",")
            return "OK displayed=\(displayedState.rawValue) ble=\(ready ? "ready" : "connecting") device_id=\(identifier.uuidString) charger_silence=\(chargingSilenceEnabled ? "on" : "off") active=\(active)"
        case "scan":
            let seconds = parts.count >= 2 ? min(15, max(2, Double(parts[1]) ?? 6)) : 6
            guard central.state == .poweredOn else { return "ERR bluetooth unavailable" }
            manualScanGeneration &+= 1
            let generation = manualScanGeneration
            manualScanActive = true
            discoveredDevices[identifier] = DiscoveredDevice(
                id: identifier.uuidString,
                name: peripheral?.name ?? "JTX-RGB",
                rssi: 0
            )
            central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
                guard let self, self.manualScanGeneration == generation else { return }
                self.manualScanActive = false
                self.central.stopScan()
            }
            return "OK scan started=\(Int(seconds))s"
        case "devices":
            let values = discoveredDevices.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            guard let data = try? JSONEncoder().encode(values) else { return "ERR unable to encode devices" }
            return "OK devices=\(data.base64EncodedString())"
        case "release":
            releaseBluetoothAndExit(after: 0.30)
            return "OK bluetooth released"
        case "charger-silence":
            guard parts.count >= 2, parts[1] == "on" || parts[1] == "off" else {
                return "ERR usage: charger-silence <on|off>"
            }
            chargingPreviewGeneration &+= 1
            chargingSilenceEnabled = parts[1] == "on"
            if displayedState == .off {
                if chargingSilenceEnabled {
                    suppressChargingIndicator()
                } else {
                    send(maxBrightnessFrame)
                }
            }
            return "OK charger-silence \(parts[1])"
        case "charger-status":
            let seconds = parts.count >= 2 ? min(300, max(1, Double(parts[1]) ?? 10)) : 10
            chargingPreviewGeneration &+= 1
            let previewGeneration = chargingPreviewGeneration
            chargingSilenceEnabled = false
            if displayedState == .off { send(maxBrightnessFrame) }
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
                guard let self, self.chargingPreviewGeneration == previewGeneration else { return }
                self.chargingSilenceEnabled = true
                if self.displayedState == .off { self.suppressChargingIndicator() }
            }
            return "OK charger-status visible-for=\(Int(seconds))s"
        case "set":
            guard parts.count >= 3, let state = LightState(rawValue: parts[2]), state != .off else {
                return "ERR usage: set <key> <green|blue|yellow|red> [ttl-seconds]"
            }
            let ttl = parts.count >= 4 ? max(1, Double(parts[3]) ?? 600) : 600
            let now = Date()
            let existing = entries[parts[1]]
            let requestedForce = parts.count >= 5 && parts[4].lowercased() == "force"
            entries[parts[1]] = StatusEntry(state: state, updatedAt: now, expiresAt: now.addingTimeInterval(ttl))
            let incomingWins = effectiveEntry()?.key == parts[1]
            refreshDisplay(force: incomingWins && (requestedForce || existing?.state != state))
            return "OK set \(parts[1]) \(state.rawValue)"
        case "clear":
            guard parts.count >= 2 else { return "ERR usage: clear <key>" }
            entries.removeValue(forKey: parts[1])
            refreshDisplay()
            return "OK clear \(parts[1])"
        case "clear-if":
            guard parts.count >= 3, let state = LightState(rawValue: parts[2]) else {
                return "ERR usage: clear-if <key> <state>"
            }
            if entries[parts[1]]?.state == state {
                entries.removeValue(forKey: parts[1])
                refreshDisplay()
            }
            return "OK clear-if \(parts[1]) \(state.rawValue)"
        case "activity":
            guard parts.count >= 2 else { return "ERR usage: activity <key>" }
            // New work means any handled attention/error state is resolved.
            // Green is deliberately preserved until its own completion TTL so
            // a prompt submitted one second later cannot make it invisible.
            if let state = entries[parts[1]]?.state,
               state == .blue || state == .yellow || state == .red {
                entries.removeValue(forKey: parts[1])
                refreshDisplay()
            }
            return "OK activity \(parts[1])"
        case "clear-all", "off":
            scheduledDemoGeneration &+= 1
            entries.removeAll()
            refreshDisplay(force: true)
            return "OK off"
        case "demo":
            guard parts.count >= 2, let state = LightState(rawValue: parts[1]), state != .off else {
                return "ERR usage: demo <green|blue|yellow|red> [seconds]"
            }
            let seconds = min(300, max(1, Double(parts.count >= 3 ? parts[2] : "60") ?? 60))
            scheduledDemoGeneration &+= 1
            let now = Date()
            entries["manual-demo"] = StatusEntry(state: state, updatedAt: now, expiresAt: now.addingTimeInterval(seconds))
            refreshDisplay(force: true)
            return "OK demo \(state.rawValue)"
        case "demo-at":
            guard parts.count >= 4,
                  let state = LightState(rawValue: parts[1]), state != .off,
                  let requestedSeconds = Double(parts[2]),
                  let startMilliseconds = Double(parts[3]) else {
                return "ERR usage: demo-at <green|blue|yellow|red> <seconds> <unix-ms>"
            }
            let seconds = min(300, max(1, requestedSeconds))
            let requestedStart = Date(timeIntervalSince1970: startMilliseconds / 1000)
            let delay = min(2, max(0, requestedStart.timeIntervalSinceNow))
            scheduledDemoGeneration &+= 1
            let generation = scheduledDemoGeneration
            preparedDemoState = state
            prepareSynchronizedDemo(state, generation: generation)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.scheduledDemoGeneration == generation else { return }
                let now = Date()
                self.preparedDemoState = nil
                self.entries["manual-demo"] = StatusEntry(state: state, updatedAt: now, expiresAt: now.addingTimeInterval(seconds))
                let next = self.effectiveState()
                self.displayedState = next
                if next == state {
                    self.animatePrepared(state)
                } else {
                    self.animate(next)
                }
            }
            return "OK demo-at \(state.rawValue) start_ms=\(Int(startMilliseconds))"
        case "raw":
            // Local diagnostics for firmware variants. This endpoint is bound
            // to 127.0.0.1 and still validates the captured BC ... 55 frame.
            let hex = parts.dropFirst().joined()
            guard hex.count >= 8, hex.count.isMultiple(of: 2),
                  let bytes = stride(from: 0, to: hex.count, by: 2).reduce(into: Optional<[UInt8]>([]), { result, index in
                      guard result != nil, let byte = UInt8(hex.dropFirst(index).prefix(2), radix: 16) else {
                          result = nil
                          return
                      }
                      result?.append(byte)
                  }),
                  bytes.first == 0xBC, bytes.last == 0x55 else {
                return "ERR usage: raw <BC...55 hex frame>"
            }
            send(bytes)
            return "OK raw \(Data(bytes).hexString)"
        default:
            return "ERR unknown command"
        }
    }

    private func pruneExpiredEntries() {
        let now = Date()
        let oldCount = entries.count
        entries = entries.filter { $0.value.expiresAt > now }
        if entries.count != oldCount { refreshDisplay() }
    }

    private func effectiveEntry() -> (key: String, value: StatusEntry)? {
        entries.max {
            if $0.value.state.priority == $1.value.state.priority {
                return $0.value.updatedAt < $1.value.updatedAt
            }
            return $0.value.state.priority < $1.value.state.priority
        }
    }

    private func effectiveState() -> LightState {
        effectiveEntry()?.value.state ?? .off
    }

    private func refreshDisplay(force: Bool = false) {
        let next = effectiveState()
        guard force || next != displayedState else { return }
        displayedState = next
        animate(next)
    }

    private func animate(_ state: LightState) {
        animationGeneration &+= 1
        let generation = animationGeneration
        log("DISPLAY state=\(state.rawValue) active=\(entries.count)")

        guard state != .off else {
            if chargingSilenceEnabled {
                suppressChargingIndicator()
            } else {
                send(powerOffFrame)
            }
            return
        }

        // Initial attention burst: six fast flashes, then steady on.
        // Zero-brightness blanks are used instead of power-off/on toggles.
        // Power toggles briefly expose the firmware's white charging frame.
        // Set the target color while brightness is zero, then reveal it.
        // Every scheduled operation checks a generation token, so a handled
        // event can cancel the sequence and turn the lamp off immediately.
        let actions: [(Double, [UInt8])] = [
            (0.00, zeroBrightnessFrame),
            (0.02, powerOnFrame),
            (0.03, staticModeFrame),
            (0.04, colorFrame(state)),
            (0.06, maxBrightnessFrame),
            (0.18, zeroBrightnessFrame),
            (0.28, colorFrame(state)),
            (0.30, maxBrightnessFrame),
            (0.42, zeroBrightnessFrame),
            (0.52, colorFrame(state)),
            (0.54, maxBrightnessFrame),
            (0.66, zeroBrightnessFrame),
            (0.76, colorFrame(state)),
            (0.78, maxBrightnessFrame),
            (0.90, zeroBrightnessFrame),
            (1.00, colorFrame(state)),
            (1.02, maxBrightnessFrame),
            (1.14, zeroBrightnessFrame),
            (1.24, colorFrame(state)),
            (1.26, maxBrightnessFrame),
            (1.38, zeroBrightnessFrame),
            (1.48, colorFrame(state)),
            (1.50, maxBrightnessFrame),
        ]

        for (delay, frame) in actions {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.animationGeneration == generation, self.displayedState == state else { return }
                self.send(frame)
            }
        }
    }

    private func prepareSynchronizedDemo(_ state: LightState, generation: UInt64) {
        animationGeneration &+= 1
        let animation = animationGeneration
        log("PREPARE state=\(state.rawValue) generation=\(generation)")
        let actions: [(Double, [UInt8])] = [
            (0.00, zeroBrightnessFrame),
            (0.03, powerOnFrame),
            (0.06, staticModeFrame),
            (0.09, colorFrame(state)),
            (0.30, colorFrame(state)),
        ]
        for (delay, frame) in actions {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self,
                      self.scheduledDemoGeneration == generation,
                      self.animationGeneration == animation,
                      self.preparedDemoState == state else { return }
                self.send(frame, quiet: true)
            }
        }
    }

    private func animatePrepared(_ state: LightState) {
        animationGeneration &+= 1
        let generation = animationGeneration
        log("DISPLAY state=\(state.rawValue) active=\(entries.count) prepared=1")
        // Color and static mode were loaded while brightness was zero. At the
        // shared timestamp every lamp needs just one visible reveal frame;
        // subsequent flashes also toggle only brightness.
        let actions: [(Double, [UInt8])] = [
            (0.00, maxBrightnessFrame),
            (0.12, zeroBrightnessFrame), (0.24, maxBrightnessFrame),
            (0.36, zeroBrightnessFrame), (0.48, maxBrightnessFrame),
            (0.60, zeroBrightnessFrame), (0.72, maxBrightnessFrame),
            (0.84, zeroBrightnessFrame), (0.96, maxBrightnessFrame),
            (1.08, zeroBrightnessFrame), (1.20, maxBrightnessFrame),
            (1.32, zeroBrightnessFrame), (1.44, maxBrightnessFrame),
        ]
        for (delay, frame) in actions {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.animationGeneration == generation, self.displayedState == state else { return }
                self.send(frame)
            }
        }
    }

    private func suppressChargingIndicator(quiet: Bool = false) {
        send(powerOffFrame, quiet: quiet)
        send(zeroBrightnessFrame, quiet: quiet)
    }

    private func releaseBluetoothAndExit(after delay: TimeInterval) {
        guard !shuttingDown else { return }
        shuttingDown = true
        reconnectPending = true
        entries.removeAll()
        scheduledDemoGeneration &+= 1
        preparedDemoState = nil
        animationGeneration &+= 1
        if ready { suppressChargingIndicator(quiet: true) }
        central.stopScan()
        log("BLE_RELEASE requested")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { exit(0) }
    }

    private func send(_ bytes: [UInt8], quiet: Bool = false) {
        guard ready, let peripheral, let characteristic = writeCharacteristic else { return }
        // The official Colorful Lights client uses acknowledged GATT writes.
        // Some newer JTX-RGB firmware advertises both write modes but silently
        // drops bursts sent with writeWithoutResponse, leaving its factory
        // flowing animation active. Prefer the reliable acknowledged channel
        // and only fall back when the characteristic truly lacks `.write`.
        let type: CBCharacteristicWriteType = characteristic.properties.contains(.write)
            ? .withResponse
            : .withoutResponse
        peripheral.writeValue(Data(bytes), for: characteristic, type: type)
        if !quiet { log("BLE_WRITE \(Data(bytes).hexString)") }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { log("BLE_WRITE_ERROR \(error.localizedDescription)") }
    }

    private func connectKnownPeripheral() {
        guard !shuttingDown, central.state == .poweredOn, peripheral == nil else { return }
        if let found = central.retrievePeripherals(withIdentifiers: [identifier]).first {
            connect(found)
        } else {
            log("BLE_RETRIEVE_MISS scanning")
            central.scanForPeripherals(withServices: [advertisedUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        }
    }

    private func connect(_ found: CBPeripheral) {
        guard !shuttingDown else { return }
        central.stopScan()
        peripheral = found
        found.delegate = self
        connectionGeneration &+= 1
        let generation = connectionGeneration
        log("BLE_CONNECT name=\(found.name ?? "JTX-RGB") id=\(found.identifier.uuidString)")
        central.connect(found, options: nil)

        // CoreBluetooth can leave a pending connection in `.connecting`
        // indefinitely without calling either didConnect or didFailToConnect.
        // That made a newly added lamp look configured while it could not
        // receive any state frames. Recycle the attempt so nearby lamps get a
        // deterministic reconnect instead of waiting for macOS for hours.
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self, weak found] in
            guard let self, let found,
                  self.connectionGeneration == generation,
                  self.peripheral === found,
                  !self.ready else { return }
            log("BLE_CONNECT_TIMEOUT retrying")
            self.connectionGeneration &+= 1
            self.peripheral = nil
            self.writeCharacteristic = nil
            self.central.cancelPeripheralConnection(found)
            self.scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard !shuttingDown, !reconnectPending else { return }
        reconnectPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.reconnectPending = false
            self.connectKnownPeripheral()
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        log("BLUETOOTH_STATE \(central.state.rawValue)")
        if central.state == .poweredOn {
            connectKnownPeripheral()
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = peripheral.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? ""
        if name.uppercased().contains("JTX-RGB") || peripheral.identifier == identifier {
            discoveredDevices[peripheral.identifier] = DiscoveredDevice(
                id: peripheral.identifier.uuidString,
                name: name.isEmpty ? "JTX-RGB" : name,
                rssi: RSSI.intValue
            )
        }
        if !manualScanActive, peripheral.identifier == identifier, self.peripheral == nil {
            connect(peripheral)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        connectionGeneration &+= 1
        log("BLE_CONNECTED")
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        connectionGeneration &+= 1
        log("BLE_CONNECT_FAILED \(error?.localizedDescription ?? "unknown")")
        self.peripheral = nil
        ready = false
        if !shuttingDown { scheduleReconnect() }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        connectionGeneration &+= 1
        log("BLE_DISCONNECTED \(error?.localizedDescription ?? "normal")")
        self.peripheral = nil
        writeCharacteristic = nil
        ready = false
        if !shuttingDown { scheduleReconnect() }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error {
            log("BLE_SERVICE_ERROR \(error.localizedDescription)")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        guard let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            log("BLE_SERVICE_MISSING FFF0")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics([writeUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error {
            log("BLE_CHARACTERISTIC_ERROR \(error.localizedDescription)")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        guard let characteristic = service.characteristics?.first(where: { $0.uuid == writeUUID }) else {
            log("BLE_CHARACTERISTIC_MISSING FFF3")
            central.cancelPeripheralConnection(peripheral)
            return
        }
        writeCharacteristic = characteristic
        log("BLE_CONTROL_CHANNEL_READY waiting_for_firmware")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.peripheral === peripheral else { return }
            self.ready = true
            log("BLE_READY")
            self.animate(self.displayedState)
        }
    }
}

private func usage() -> Never {
    FileHandle.standardError.write(Data("Usage: agent-light-daemon <device-uuid> [port]\n".utf8))
    exit(64)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let rawIdentifier = arguments.first, let identifier = UUID(uuidString: rawIdentifier) else { usage() }
let port = arguments.count >= 2 ? UInt16(arguments[1]) ?? defaultPort : defaultPort
private let daemon = AgentLightDaemon(identifier: identifier, port: port)
do {
    try daemon.start()
} catch {
    FileHandle.standardError.write(Data("agent-light-daemon: \(error)\n".utf8))
    exit(1)
}
RunLoop.main.run()
