import { execFile } from "node:child_process";

export type RunResult = { code: number; stdout: string; stderr: string };

// Runs a program and resolves with its exit code, a non-zero one included.
// Tests and the commands that start other programs pass a stand-in for it.
export type Runner = (file: string, args: string[]) => Promise<RunResult>;

export class CommandNotFoundError extends Error {
  constructor(readonly file: string) {
    super(`${file} was not found on PATH`);
  }
}

const timeoutMs = 60_000;

export const runCommand: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return reject(new CommandNotFoundError(file));
      if (typeof code === "number") return resolve({ code, stdout, stderr });
      reject(error);
    });
  });
