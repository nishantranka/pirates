export class Input {
  private down = new Set<string>();
  private justPressed = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      this.down.add(e.code);
      if (!e.repeat) this.justPressed.add(e.code);
      // Keep Space/arrows from scrolling the page.
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True only on the frame the key went down (until clearPressed). */
  wasPressed(code: string): boolean {
    return this.justPressed.has(code);
  }

  /** Call at the end of each update so presses are edge-triggered. */
  clearPressed() {
    this.justPressed.clear();
  }
}
