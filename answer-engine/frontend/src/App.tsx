import { useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import { AnswerLog } from "./pages/AnswerLog";
import { Ask } from "./pages/Ask";
import { Documents } from "./pages/Documents";
import { Forgot } from "./pages/Forgot";
import { Placeholder } from "./pages/Placeholder";
import { Profile } from "./pages/Profile";
import { ReviewQueue } from "./pages/ReviewQueue";
import { SetPassword } from "./pages/SetPassword";
import { Settings } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { Users } from "./pages/Users";
import { usePath } from "./router";
import { reviewsChanged } from "./events";
import { Shell } from "./Shell";

const PLACEHOLDERS: Record<string, [string, number]> = {
  "/marketing": ["Marketing", 13],
  "/verified": ["Verified Answers", 11],
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
  else if (path === "/") page = <Ask />;
  else if (path === "/settings" && user.role === "owner") page = <Settings />;
  else if (path === "/answer-log" && user.role !== "user") page = <AnswerLog />;
  else if (path === "/reviews" && user.role !== "user")
    page = <ReviewQueue onChange={reviewsChanged} />;
  else {
    const known = PLACEHOLDERS[path];
    page = known ? <Placeholder title={known[0]} step={known[1]} /> : <Ask />;
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
