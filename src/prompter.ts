import { createInterface, type Interface } from "node:readline";
import { Writable, type Readable } from "node:stream";

export interface Prompter {
  // Returns the fallback when the answer is empty.
  ask(question: string, fallback?: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  // Reads a line without echoing it.
  secret(question: string): Promise<string>;
  close(): void;
}

class SwitchableOutput extends Writable {
  muted = false;

  constructor(private readonly target: Writable) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.muted) return done();
    this.target.write(chunk, done);
  }
}

// Lines are queued as they arrive, because piped input delivers several at once
// and readline's own question call drops the ones that come while nothing is asking.
export class TerminalPrompter implements Prompter {
  private readonly output: SwitchableOutput;
  private readonly lines: Interface;
  private readonly queued: string[] = [];
  private readonly waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private ended = false;

  constructor(
    input: Readable,
    private readonly display: Writable,
    terminal: boolean,
  ) {
    this.output = new SwitchableOutput(display);
    this.lines = createInterface({ input, output: this.output, terminal, prompt: "" });
    this.lines.on("line", (line) => {
      const next = this.waiting.shift();
      if (next) next.resolve(line);
      else this.queued.push(line);
    });
    this.lines.on("close", () => {
      this.ended = true;
      for (const next of this.waiting.splice(0)) {
        next.reject(new Error("the input ended before every question was answered, pass the answers as options or use --yes"));
      }
    });
  }

  async ask(question: string, fallback?: string): Promise<string> {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await this.readLine(`${question}${suffix}: `)).trim();
    return answer || fallback || "";
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    for (;;) {
      const answer = (await this.readLine(`${question} [${fallback ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
      if (answer === "") return fallback;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
    }
  }

  async secret(question: string): Promise<string> {
    return (await this.readLine(`${question}: `, true)).trim();
  }

  close(): void {
    this.lines.close();
  }

  private readLine(prompt: string, hidden = false): Promise<string> {
    // The question goes straight to the display so that muting the line editor cannot hide it.
    this.display.write(prompt);
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.reject(new Error("the input ended before every question was answered, pass the answers as options or use --yes"));
    this.output.muted = hidden;
    return new Promise<string>((resolve, reject) => this.waiting.push({ resolve, reject })).finally(() => {
      this.output.muted = false;
      if (hidden) this.output.write("\n");
    });
  }
}
