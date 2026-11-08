// Agent input source (see controller.js for the source interface
// contract). The agent harness (src/agent/) writes the twist here through
// set()/stop(); it owns the command only while active, so keyboard, pad
// and touch (registered ahead of it) always win arbitration.

export class AgentSource {
  id = "agent";
  connected = true;
  command = new Float32Array(3); // [vx, 0, wz]
  axes = { jaw: 0, orbitX: 0, orbitY: 0 };
  pressed = {};
  onAction = () => {}; // assigned by the Controller at registration

  #active = false;

  set(vx, wz) {
    this.command[0] = vx;
    this.command[2] = wz;
    this.#active = true;
  }

  stop() {
    this.command.fill(0);
    this.#active = false;
  }

  isActive() {
    return this.#active;
  }
}
