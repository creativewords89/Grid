import { useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import { Documents } from "./pages/Documents";
import { Forgot } from "./pages/Forgot";
import { Placeholder } from "./pages/Placeholder";
import { Profile } from "./pages/Profile";
import { SetPassword } from "./pages/SetPassword";
import { SignIn } from "./pages/SignIn";
import { Users } from "./pages/Users";
import { usePath } from "./router";
import { Shell } from "./Shell";

const PLACEHOLDERS: Record<string, [string, number]> = {
  "/": ["Ask", 8],
  "/marketing": ["Marketing", 13],
  "/verified": ["Verified Answers", 11],
  "/reviews": ["Review Queue", 10],
  "/answer-log": ["Answer Log", 9],
  "/settings": ["Settings", 14],
};

function Routes() {
  const path = usePath();
  const { user, loading } = useAuth();
  const [notice, setNotice] = useState("");

  if (path === "/invite") return <SetPassword mode="invite" onReset={setNotice} />;
  if (path === "/reset") return <SetPassword mode="reset" onReset={setNotice} />;
  if (loading) return <p className="loading">Loading…</p>;
  if (!user) return path === "/forgot" ? <Forgot /> : <SignIn notice={notice} />;

  let page;
  if (path === "/users" && user.role === "owner") page = <Users />;
  else if (path === "/profile") page = <Profile />;
  else if (path === "/documents") page = <Documents />;
  else {
    const [title, step] = PLACEHOLDERS[path] ?? PLACEHOLDERS["/"]!;
    page = <Placeholder title={title} step={step} />;
  }
  return <Shell path={path}>{page}</Shell>;
}

export function App() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}
