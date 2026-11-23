import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { copyLabel, copyText, useCopy } from "./clipboard";

function stubClipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

function stubExecCommand(result: boolean | Error) {
  const fn = vi.fn(() => {
    if (result instanceof Error) throw result;
    return result;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: fn });
  return fn;
}

afterEach(() => {
  stubClipboard();
  vi.restoreAllMocks();
});

test("copies with the clipboard API when the browser allows it", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  stubClipboard(writeText);
  const exec = stubExecCommand(true);

  expect(await copyText("hello")).toBe(true);
  expect(writeText).toHaveBeenCalledWith("hello");
  expect(exec).not.toHaveBeenCalled();
});

test("falls back to a hidden text box when the browser refuses", async () => {
  stubClipboard(() => Promise.reject(new DOMException("blocked", "NotAllowedError")));
  let copied = "";
  const exec = stubExecCommand(true);
  exec.mockImplementation(() => {
    copied = document.querySelector("textarea")?.value ?? "";
    return true;
  });

  expect(await copyText("hello")).toBe(true);
  expect(copied).toBe("hello");
  expect(document.querySelector("textarea")).toBeNull(); // cleaned up
});

test("without the clipboard API, the text box is used", async () => {
  stubClipboard();
  stubExecCommand(true);
  expect(await copyText("hello")).toBe(true);
});

test("says so when nothing works", async () => {
  stubClipboard(() => Promise.reject(new Error("no")));
  stubExecCommand(new Error("not supported"));
  expect(await copyText("hello")).toBe(false);
  stubExecCommand(false);
  expect(await copyText("hello")).toBe(false);
});

function Button() {
  const [state, copy] = useCopy();
  return <button onClick={() => copy("hi")}>{copyLabel(state)}</button>;
}

test("the button says Copied, or Couldn't copy, then goes back", async () => {
  stubClipboard(() => Promise.resolve());
  render(<Button />);
  await userEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByRole("button", { name: "Copied ✓" })).toBeVisible();

  stubClipboard(() => Promise.reject(new Error("no")));
  stubExecCommand(false);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await userEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("button", { name: "Couldn't copy" })).toBeVisible();
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
  vi.useRealTimers();
});
