/** Emits only syntactically complete top-level members. Never repairs JSON. */
export class CompletedJsonFields {
  private text = "";
  private cursor = 0;
  private start = 0;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private opened = false;
  private closed = false;
  private afterComma = false;
  private keys = new Set<string>();

  async push(delta: string, publish: (key: string, value: unknown) => Promise<void>) {
    this.text += delta;
    for (; this.cursor < this.text.length; this.cursor++) {
      const char = this.text[this.cursor];
      if (this.closed) {
        if (char.trim()) throw new Error("Invalid structured response suffix.");
        continue;
      }
      if (!this.opened) {
        if (!char.trim()) continue;
        if (char !== "{") throw new Error("Structured response must be an object.");
        this.opened = true;
        this.depth = 1;
        this.start = this.cursor + 1;
        continue;
      }
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (char === "\\") this.escaped = true;
        else if (char === '"') this.quoted = false;
        continue;
      }
      if (char === '"') this.quoted = true;
      else if (char === "{" || char === "[") this.depth++;
      else if (char === "}" || char === "]") this.depth--;
      if ((char === "," && this.depth === 1) || (char === "}" && this.depth === 0)) {
        const member = this.text.slice(this.start, this.cursor).trim();
        if (!member && (char === "," || this.afterComma)) throw new Error("Empty JSON member.");
        if (member) {
          let object: unknown;
          try { object = JSON.parse(`{${member}}`); }
          catch { throw new Error("Malformed structured response member."); }
          const entries = Object.entries(object as Record<string, unknown>);
          if (entries.length !== 1) throw new Error("Invalid JSON member.");
          const [key, value] = entries[0];
          if (this.keys.has(key)) throw new Error("Duplicate structured response field.");
          this.keys.add(key);
          await publish(key, value);
        }
        this.afterComma = char === ",";
        this.start = this.cursor + 1;
        this.closed = char === "}";
      }
    }
  }

  finish() {
    if (!this.closed || this.quoted || this.depth !== 0) throw new Error("Incomplete structured response.");
    return this.text;
  }
}
