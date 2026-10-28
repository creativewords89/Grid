import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { ConnectionField, Connections } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const owner = [200, { user: makeUser({ role: "owner" }), csrf_token: "t" }] as [number, unknown];

function f(over: Partial<ConnectionField> & { name: string; label: string }): ConnectionField {
  return {
    secret: false,
    number: false,
    placeholder: "",
    set: false,
    source: null,
    value: "",
    hint: null,
    ...over,
  };
}

function data(keySet: boolean): Connections {
  return {
    groups: [
      {
        id: "anthropic",
        name: "Claude (Anthropic)",
        ready: keySet,
        fields: [
          f({
            name: "anthropic_api_key",
            label: "API key",
            secret: true,
            set: keySet,
            source: keySet ? "portal" : null,
            value: null,
            hint: keySet ? "••••WXYZ" : null,
          }),
        ],
      },
      {
        id: "email",
        name: "Email (SMTP)",
        ready: false,
        fields: [
          f({ name: "smtp_host", label: "SMTP server" }),
          f({
            name: "smtp_port",
            label: "Port",
            number: true,
            value: "587",
            set: true,
            source: "default",
          }),
        ],
      },
    ],
  };
}

function card(name: string): HTMLElement {
  return screen.getByRole("form", { name }) as HTMLElement;
}

beforeEach(() => window.history.pushState(null, "", "/settings"));
afterEach(() => vi.unstubAllGlobals());

test("save a key: only its last four characters show afterwards", async () => {
  const key = "sk-ant-api03-abcdefghijklmnop-WXYZ";
  const calls = mockApi({
    "GET /auth/me": owner,
    "GET /connections": [200, data(false)],
    "PATCH /connections": [200, data(true)],
  });
  render(<App />);

  const claude = await screen.findByRole("form", { name: "Claude (Anthropic)" });
  expect(within(claude).getByText("Not set up")).toBeVisible();
  expect(within(claude).getByRole("button", { name: "Test the key" })).toBeDisabled();
  await userEvent.type(within(claude).getByLabelText("API key"), key);
  await userEvent.click(within(claude).getByRole("button", { name: "Save" }));

  const saved = card("Claude (Anthropic)");
  expect(await within(saved).findByText("Set up")).toBeVisible();
  const input = within(saved).getByLabelText("API key");
  expect(input).toHaveValue("");
  expect(input).toHaveAttribute("type", "password");
  expect(within(saved).getByText(/Set \(••••WXYZ\), saved here/)).toBeVisible();
  expect(document.body.textContent).not.toContain(key);
  // Only the changed field was sent: the email card's values weren't touched.
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    values: { anthropic_api_key: key },
  });
});

test("the Test button reports what the service said", async () => {
  mockApi({
    "GET /auth/me": owner,
    "GET /connections": [200, data(true)],
    "POST /connections/anthropic/test": [
      200,
      { ok: false, message: "Claude refused the key: invalid x-api-key" },
    ],
  });
  render(<App />);

  const claude = await screen.findByRole("form", { name: "Claude (Anthropic)" });
  await userEvent.click(within(claude).getByRole("button", { name: "Test the key" }));
  expect(await screen.findByText("Claude refused the key: invalid x-api-key")).toBeVisible();
});

test("a saved key can be removed", async () => {
  const calls = mockApi({
    "GET /auth/me": owner,
    "GET /connections": [200, data(true)],
    "PATCH /connections": [200, data(false)],
  });
  render(<App />);

  const claude = await screen.findByRole("form", { name: "Claude (Anthropic)" });
  await userEvent.click(within(claude).getByRole("button", { name: "Remove" }));
  expect(await within(card("Claude (Anthropic)")).findByText("Not set up")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    values: { anthropic_api_key: null },
  });
});

test("saving with nothing typed says so", async () => {
  const calls = mockApi({ "GET /auth/me": owner, "GET /connections": [200, data(true)] });
  render(<App />);

  const claude = await screen.findByRole("form", { name: "Claude (Anthropic)" });
  await userEvent.click(within(claude).getByRole("button", { name: "Save" }));
  expect(await within(claude).findByText(/Nothing to save/)).toBeVisible();
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
});

test("Pinecone lists the namespaces the Answer Engine uses", async () => {
  const withPinecone = data(true);
  withPinecone.groups.push({
    id: "pinecone",
    name: "Pinecone",
    ready: true,
    fields: [f({ name: "pinecone_index", label: "Index", value: "answer-engine", set: true })],
    namespaces: [
      {
        namespace: "docs",
        used_for: "Knowledge base (facts)",
        records: 1240,
        last_synced: new Date().toISOString(),
        pending: false,
      },
      {
        namespace: "voice-facebook",
        used_for: "Brand voice: Facebook",
        records: 66,
        last_synced: null,
        pending: true,
      },
    ],
  });
  mockApi({ "GET /auth/me": owner, "GET /connections": [200, withPinecone] });
  render(<App />);

  const pinecone = await screen.findByRole("form", { name: "Pinecone" });
  const table = within(pinecone).getByRole("table");
  expect(within(table).getByText("voice-facebook")).toBeVisible();
  expect(within(table).getByText("Brand voice: Facebook")).toBeVisible();
  expect(within(table).getByText((1240).toLocaleString())).toBeVisible();
  expect(within(table).getByText("Sync pending")).toBeVisible();
  expect(
    within(pinecone).getByText(/Other namespaces in this index are not touched/),
  ).toBeVisible();
});
