import { useEffect, useState } from "react";
import { api } from "./api";
import { AuthProvider, useAuth } from "./auth";
import { AnswerLog } from "./pages/AnswerLog";
import { Ask } from "./pages/Ask";
import { Documents } from "./pages/Documents";
import { FirstRun } from "./pages/FirstRun";
import { Forgot } from "./pages/Forgot";
import { Marketing } from "./pages/Marketing";
import { Profile } from "./pages/Profile";
import { ReviewQueue } from "./pages/ReviewQueue";
import { SetPassword } from "./pages/SetPassword";
import { Settings } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { Users } from "./pages/Users";
import { Verified } from "./pages/Verified";
import { usePath } from "./router";
import { reviewsChanged } from "./events";
import { Shell } from "./Shell";

function Routes() {
  const path = usePath();
  const { user, loading } = useAuth();
  const [notice, setNotice] = useState("");
  // A brand-new install has no accounts: offer to create the Owner instead of signing in.
  const [firstRun, setFirstRun] = useState(false);
  useEffect(() => {
    if (loading || user) return;
    api
      .setupState()
      .then((state) => setFirstRun(state.needed))
      .catch(() => setFirstRun(false));
  }, [loading, user]);

  if (path === "/invite") return <SetPassword mode="invite" onReset={setNotice} />;
  if (path === "/reset") return <SetPassword mode="reset" onReset={setNotice} />;
  if (loading) return <p className="loading">Loading…</p>;
  if (!user && firstRun) return <FirstRun />;
  if (!user) return path === "/forgot" ? <Forgot /> : <SignIn notice={notice} />;

  let page;
  if (path === "/users" && user.role === "owner") page = <Users />;
  else if (path === "/profile") page = <Profile />;
  else if (path === "/documents") page = <Documents />;
  else if (path === "/") page = <Ask />;
  else if (path === "/settings" && user.role === "owner") page = <Settings />;
  else if (path === "/answer-log" && user.role !== "user") page = <AnswerLog />;
  else if (path === "/verified") page = <Verified />;
  else if (path === "/reviews" && user.role !== "user")
    page = <ReviewQueue onChange={reviewsChanged} />;
  else if (path === "/marketing") page = <Marketing />;
  else page = <Ask />;
  return <Shell path={path}>{page}</Shell>;
}

export function App() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}
