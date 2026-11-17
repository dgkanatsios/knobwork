import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebBluetoothTransport } from '../src/transport/web-bluetooth.js';

test('a transport stops listening to the device once it is closed or disconnected', async () => {
  const device = Object.assign(new EventTarget(), { gatt: { disconnect() {} } });
  const rx = Object.assign(new EventTarget(), { stopNotifications: async () => {} });
  let calls = 0;

  const lost = new WebBluetoothTransport(device, {}, rx);
  lost.onDisconnect = () => calls++;
  device.dispatchEvent(new Event('gattserverdisconnected'));
  device.dispatchEvent(new Event('gattserverdisconnected'));
  assert.equal(calls, 1);

  const closed = new WebBluetoothTransport(device, {}, rx);
  closed.onDisconnect = () => calls++;
  await closed.close();
  device.dispatchEvent(new Event('gattserverdisconnected'));
  assert.equal(calls, 1);
});
