import { useEffect, useState } from "react";
import { api } from "./api";
import { AuthProvider, useAuth } from "./auth";
import { Agents } from "./pages/Agents";
import { Batches } from "./pages/Batches";
import { Benchmarks } from "./pages/Benchmarks";
import { Connections } from "./pages/Connections";
import { FirstRun } from "./pages/FirstRun";
import { Forgot } from "./pages/Forgot";
import { History } from "./pages/History";
import { Overview } from "./pages/Overview";
import { Profile } from "./pages/Profile";
import { Runs } from "./pages/Runs";
import { SetPassword } from "./pages/SetPassword";
import { SignIn } from "./pages/SignIn";
import { Users } from "./pages/Users";
import { usePath } from "./router";
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
  else if (path === "/connections" && user.role === "owner") page = <Connections />;
  else if (path === "/history" && user.role === "owner") page = <History />;
  else if (path === "/agents") page = <Agents />;
  else if (path === "/runs") page = <Runs />;
  // A batch's leads are in the batch: /leads?batch=<id> opens its Leads tab.
  else if (path === "/batches" || path === "/import" || path === "/leads") page = <Batches />;
  else if (path === "/benchmarks") page = <Benchmarks />;
  else if (path === "/profile") page = <Profile />;
  else page = <Overview />;
  return <Shell path={path}>{page}</Shell>;
}

export function App() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}
