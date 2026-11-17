// Web Bluetooth transport (Chrome and other Chromium browsers). GATT writes are serialized because Chromium rejects a
// write while another one is in progress.

export const SERVICE = 0xffd0;
export const WRITE_CHAR = 0xffc1;
export const NOTIFY_CHAR = 0xffc2;

export class WebBluetoothTransport {
  constructor(device, tx, rx) {
    this.device = device;
    this.tx = tx;
    this.rx = rx;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.chain = Promise.resolve();
    this.handleValue = (e) => {
      const v = e.target.value;
      this.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    };
    // The browser reuses the device object for later connections, so a closed or lost connection must not keep
    // listening on it.
    this.handleDisconnect = () => {
      this.detach();
      this.onDisconnect();
    };
    rx.addEventListener('characteristicvaluechanged', this.handleValue);
    device.addEventListener('gattserverdisconnected', this.handleDisconnect);
  }

  detach() {
    this.rx.removeEventListener('characteristicvaluechanged', this.handleValue);
    this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
  }

  static async request(bluetooth = navigator.bluetooth) {
    // By service, or by name in case a platform does not report the advertised service.
    const device = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }, { namePrefix: 'Reactor' }], optionalServices: [SERVICE] });
    return WebBluetoothTransport.connect(device);
  }

  static async connect(device) {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    const tx = await service.getCharacteristic(WRITE_CHAR);
    const rx = await service.getCharacteristic(NOTIFY_CHAR);
    const transport = new WebBluetoothTransport(device, tx, rx);
    await rx.startNotifications();
    return transport;
  }

  get name() {
    return this.device.name;
  }

  write(bytes) {
    const run = this.chain.then(() => this.tx.writeValueWithoutResponse(bytes));
    this.chain = run.catch(() => {});
    return run;
  }

  async close() {
    this.detach();
    try {
      await this.rx.stopNotifications();
    } catch {
      // already disconnected
    }
    this.device.gatt.disconnect();
  }
}
