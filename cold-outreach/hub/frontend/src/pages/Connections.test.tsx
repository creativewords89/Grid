import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { ConnectionField, ConnectionGroup, Connections } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const owner = makeUser({ role: "owner", name: "Olivia" });
const signedIn = [200, { user: owner, csrf_token: "t" }] as [number, unknown];

function field(overrides: Partial<ConnectionField>): ConnectionField {
  return {
    name: "x",
    label: "X",
    kind: "text",
    placeholder: "",
    required: true,
    set: false,
    unreadable: false,
    value: "",
    hint: null,
    ...overrides,
  };
}

function data(dataforseo: Partial<ConnectionGroup> = {}): Connections {
  return {
    groups: [
      {
        id: "dataforseo",
        name: "DataForSEO",
        ready: false,
        last_test: null,
        fields: [
          field({ name: "dataforseo_login", label: "Login (API email)" }),
          field({
            name: "dataforseo_password",
            label: "API password",
            kind: "secret",
            value: null,
          }),
        ],
        ...dataforseo,
      },
      {
        id: "google",
        name: "Google (Sheets and Drive)",
        ready: false,
        last_test: null,
        fields: [
          field({
            name: "google_service_account",
            label: "Service account key (JSON file)",
            kind: "json",
            value: null,
          }),
        ],
      },
    ],
  };
}

beforeEach(() => window.history.pushState(null, "", "/connections"));
afterEach(() => vi.unstubAllGlobals());

test("the Owner saves a login and password; only what was typed is sent", async () => {
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /connections": [200, data()],
    "PATCH /connections": [
      200,
      data({
        ready: true,
        fields: [
          field({ name: "dataforseo_login", label: "Login (API email)", value: "me@gr.com" }),
          field({
            name: "dataforseo_password",
            label: "API password",
            kind: "secret",
            set: true,
            value: null,
            hint: "••••9876",
          }),
        ],
      }),
    ],
  });
  render(<App />);

  const form = await screen.findByRole("form", { name: "DataForSEO" });
  await userEvent.type(within(form).getByLabelText("Login (API email)"), "me@gr.com");
  await userEvent.type(within(form).getByLabelText("API password"), "secret-9876");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));

  const saved = await screen.findByRole("form", { name: "DataForSEO" });
  expect(within(saved).getByText(/Saved \(••••9876\)/)).toBeVisible();
  expect(within(saved).getByText("Set up")).toBeVisible();
  expect(within(saved).getByLabelText("API password")).toHaveValue("");
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    values: { dataforseo_login: "me@gr.com", dataforseo_password: "secret-9876" },
  });
});

test("the Test result is shown", async () => {
  let tested = false;
  mockApi({
    "GET /auth/me": signedIn,
    "GET /connections": () => [
      200,
      data({
        ready: true,
        last_test: tested
          ? { ok: true, message: "Connected. Balance: $48.50.", at: new Date().toISOString() }
          : null,
      }),
    ],
    "POST /connections/dataforseo/test": () => {
      tested = true;
      return [200, { ok: true, message: "Connected. Balance: $48.50.", at: "" }];
    },
  });
  render(<App />);

  const form = await screen.findByRole("form", { name: "DataForSEO" });
  await userEvent.click(within(form).getByRole("button", { name: "Test and show balance" }));

  expect(await screen.findByText("Connected. Balance: $48.50.")).toBeVisible();
});

test("the key file is read from disk and sent as text", async () => {
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /connections": [200, data()],
    "PATCH /connections": [200, data()],
  });
  render(<App />);

  const form = await screen.findByRole("form", { name: "Google (Sheets and Drive)" });
  const input = within(form).getByLabelText("Service account key (JSON file)");
  const key = '{"type": "service_account"}';
  fireEvent.change(input, { target: { files: [new File([key], "key.json")] } });
  expect(await within(form).findByText("Key file ready to save.")).toBeVisible();
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));

  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    values: { google_service_account: key },
  });
});

test("a field error from the server shows under the field", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /connections": [200, data()],
    "PATCH /connections": [
      422,
      {
        error: {
          code: "invalid",
          message: "Enter an email address.",
          fields: { dataforseo_login: "Enter an email address." },
        },
      },
    ],
  });
  render(<App />);

  const form = await screen.findByRole("form", { name: "DataForSEO" });
  await userEvent.type(within(form).getByLabelText("Login (API email)"), "nope");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));

  expect(await within(form).findAllByText("Enter an email address.")).toHaveLength(2);
});

test("Admins and Viewers don't see Connections", async () => {
  const calls = mockApi({
    "GET /auth/me": [200, { user: makeUser({ role: "admin" }), csrf_token: "t" }],
    "GET /health": [200, { status: "ok", version: "0.1.0", checks: { database: "ok" } }],
  });

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Overview" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Connections" })).not.toBeInTheDocument();
  expect(calls.some((c) => c.path === "/connections")).toBe(false);
});
