import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Voice,
  type VoiceEmojis,
  type VoiceExample,
  type VoiceLinks,
  type VoicePlatform,
  type VoiceRules,
  type VoiceTry,
} from "../api";
import { Alert, Confirm } from "../components/ui";
import { formatDate } from "../format";

// Documents → Brand voice (SPEC sections 6.13 and 7.2): how we write on each platform.
// Examples teach the tone, length and wording; facts still come only from the knowledge base.
// Everyone can see it and try it; only the Owner changes it.

type Part = "examples" | "guide" | "try" | "approve";
const PLATFORM_KEY = "brand-voice-platform";
const TEMPLATE =
  "question,answer,group,notes\n" +
  '"Can I use a PO box for my Google Business Profile?","Sadly no, Google wants a real address. If you work from home you can hide it and set a service area instead.",,\n';

function savedPlatform(): string {
  try {
    return window.localStorage.getItem(PLATFORM_KEY) ?? "";
  } catch {
    return "";
  }
}

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function BrandVoice() {
  const [platforms, setPlatforms] = useState<VoicePlatform[] | null>(null);
  const [chosen, setChosen] = useState(savedPlatform);
  const [part, setPart] = useState<Part>("examples");
  const [voice, setVoice] = useState<Voice | null>(null);
  const [error, setError] = useState("");

  const loadPlatforms = useCallback(() => {
    api
      .voicePlatforms()
      .then((all) => setPlatforms(all.filter((p) => p.enabled || p.examples > 0)))
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, []);
  useEffect(loadPlatforms, [loadPlatforms]);

  const slugs = platforms?.map((p) => p.slug) ?? [];
  const slug = slugs.includes(chosen) ? chosen : slugs[0];

  const load = useCallback(() => {
    if (!slug) return;
    api
      .voice(slug)
      .then((v) => {
        setVoice(v);
        setError("");
      })
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [slug]);
  useEffect(load, [load]);

  function pick(next: string) {
    setChosen(next);
    try {
      window.localStorage.setItem(PLATFORM_KEY, next);
    } catch {
      // Only remembered for this visit.
    }
  }

  const changed = useCallback(
    (next?: Voice) => {
      if (next) setVoice(next);
      else load();
      loadPlatforms();
    },
    [load, loadPlatforms],
  );

  if (platforms && platforms.length === 0) {
    return <Alert kind="info">No platform is switched on. The Owner can do it in Settings.</Alert>;
  }
  const current = voice && voice.slug === slug ? voice : null;
  return (
    <div className="stack bv">
      <p className="muted">
        How we write on each platform. Examples teach the tone, length and wording. Facts still come
        only from the Knowledge base.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="bv-bar">
        <div className="mk-tabs bv-platforms" role="tablist" aria-label="Platform">
          {platforms?.map((p) => (
            <button
              key={p.slug}
              role="tab"
              aria-selected={p.slug === slug}
              onClick={() => pick(p.slug)}
            >
              {p.name}
            </button>
          ))}
        </div>
        {current && (
          <nav className="bv-parts" aria-label={`${current.name} brand voice`}>
            {(
              [
                ["examples", "Examples"],
                ["guide", "Style guide & rules"],
                ["try", "Try it"],
                ["approve", "To approve"],
              ] as [Part, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                className="bv-part"
                aria-pressed={part === key}
                onClick={() => setPart(key)}
              >
                {label}
                {key === "approve" && current.suggested > 0 && (
                  <span className="bv-count">{current.suggested}</span>
                )}
              </button>
            ))}
          </nav>
        )}
      </div>
      {current && part === "examples" && (
        <Examples key={slug} voice={current} onChanged={changed} />
      )}
      {current && part === "guide" && (
        <GuideAndRules key={slug} voice={current} onChanged={changed} />
      )}
      {current && part === "try" && <TryIt key={slug} voice={current} />}
      {current && part === "approve" && <Approve key={slug} voice={current} onChanged={changed} />}
      {current && !current.can_manage && (
        <p className="muted small">Only the Owner can change Brand voice. Everyone can see it.</p>
      )}
    </div>
  );
}

// --- Examples ----------------------------------------------------------------------------------

function Examples({ voice, onChanged }: { voice: Voice; onChanged: (v?: Voice) => void }) {
  const [list, setList] = useState<{ items: VoiceExample[]; total: number } | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<VoiceExample | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const templateUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`;

  const load = useCallback(() => {
    api
      .voiceExamples(voice.slug, "active", query.trim())
      .then(setList)
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [voice.slug, query]);
  useEffect(load, [load]);

  async function more() {
    if (!list) return;
    try {
      const next = await api.voiceExamples(voice.slug, "active", query.trim(), list.items.length);
      setList({ items: [...list.items, ...next.items], total: next.total });
    } catch (err) {
      setError(message(err, "Not loaded."));
    }
  }

  async function upload(file: File) {
    setError("");
    setNotice("");
    setProgress(0);
    try {
      const result = await api.uploadVoice(voice.slug, file, setProgress);
      const extra = [
        result.skipped
          ? `${result.skipped} row${result.skipped === 1 ? "" : "s"} without a question or answer`
          : "",
        result.duplicates
          ? `${result.duplicates} duplicate${result.duplicates === 1 ? "" : "s"}`
          : "",
      ].filter(Boolean);
      setNotice(
        `Added ${result.added} example${result.added === 1 ? "" : "s"}.` +
          (extra.length ? ` Skipped ${extra.join(" and ")}.` : "") +
          (voice.guide_edited ? "" : " The style guide is being written from them."),
      );
      onChanged(result.voice);
      load();
    } catch (err) {
      setError(message(err, "Not uploaded."));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  }

  async function change(example: VoiceExample, patch: Partial<VoiceExample>) {
    try {
      const next = await api.updateVoiceExample(example.id, patch);
      setList((l) => l && { ...l, items: l.items.map((e) => (e.id === next.id ? next : e)) });
    } catch (err) {
      setError(message(err, "Not saved."));
    }
  }

  const total = voice.from_file + voice.from_posted;
  return (
    <>
      <section className="card bv-file" aria-labelledby="bv-file">
        <div className="grow">
          <strong id="bv-file">{voice.file ? voice.file.name : "No examples file yet"}</strong>
          <p className="muted small">
            {voice.file
              ? `${voice.from_file} examples · uploaded${voice.file.uploaded_by ? ` by ${voice.file.uploaded_by.name}` : ""}${voice.file.uploaded_at ? ` on ${formatDate(voice.file.uploaded_at)}` : ""}`
              : `Upload a spreadsheet of real ${voice.name} questions with the answers you liked.`}
          </p>
        </div>
        <a className="button" href={templateUrl} download="brand-voice-template.csv">
          Download template
        </a>
        {voice.can_manage && (
          <>
            <input
              ref={input}
              type="file"
              accept=".xlsx,.csv"
              className="sr-only"
              id="bv-upload"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <button
              className="button button-primary"
              disabled={progress !== null}
              onClick={() => input.current?.click()}
            >
              {progress !== null
                ? `Uploading… ${progress}%`
                : voice.file
                  ? "Upload new version"
                  : "Upload examples"}
            </button>
          </>
        )}
      </section>
      <p className="hint">
        Spreadsheet columns: <strong>question</strong>, <strong>answer</strong>, group (optional),
        notes (optional). Excel or CSV, so a Google Sheet works too (File → Download → .xlsx). A new
        version replaces the file's examples; approved posted replies stay.
      </p>
      {notice && <Alert kind="success">{notice}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}

      <section className="card bv-list" aria-labelledby="bv-list">
        <div className="bv-list-head">
          <h2 id="bv-list">
            {total} example{total === 1 ? "" : "s"}{" "}
            <span className="muted small">
              · {voice.from_file} from the file, {voice.from_posted} from posted replies
            </span>
          </h2>
          <label className="sr-only" htmlFor="bv-search">
            Search examples
          </label>
          <input
            id="bv-search"
            className="input"
            placeholder="Search examples"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {list && list.items.length === 0 && (
          <p className="muted bv-empty">{query ? "No example matches." : "No examples yet."}</p>
        )}
        {list && list.items.length > 0 && (
          <div className="table-wrap">
            <table className="table bv-table">
              <thead>
                <tr>
                  <th scope="col">Their question</th>
                  <th scope="col">Our answer</th>
                  <th scope="col">Group</th>
                  <th scope="col">From</th>
                  <th scope="col">Used</th>
                  {voice.can_manage && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {list.items.map((e) => (
                  <tr key={e.id} className={e.enabled ? undefined : "row-muted"}>
                    <td>
                      <strong>{e.question}</strong>
                      {e.starred && <span className="bv-star"> ★</span>}
                    </td>
                    <td className="bv-answer">{e.answer}</td>
                    <td>{e.community ?? "—"}</td>
                    <td>
                      <span className={`tag ${e.source === "posted" ? "tag-ok" : ""}`}>
                        {e.source === "posted" ? "Posted reply" : "File"}
                      </span>
                    </td>
                    <td className="muted">{e.used_count}×</td>
                    {voice.can_manage && (
                      <td className="bv-actions">
                        <label className="inline">
                          <input
                            type="checkbox"
                            checked={e.enabled}
                            onChange={() => void change(e, { enabled: !e.enabled })}
                          />
                          On
                        </label>
                        <button
                          className="link-button"
                          aria-pressed={e.starred}
                          onClick={() => void change(e, { starred: !e.starred })}
                        >
                          {e.starred ? "Unstar" : "Star"}
                        </button>
                        <button className="link-button" onClick={() => setDeleting(e)}>
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list && list.items.length < list.total && (
          <div className="bv-more">
            <button className="button" onClick={() => void more()}>
              Show more
            </button>
          </div>
        )}
      </section>
      {deleting && (
        <Confirm
          title="Delete this example?"
          message="It stops teaching the style straight away. To use it again, upload it again."
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            void api
              .deleteVoiceExample(target.id)
              .then(() => {
                load();
                onChanged();
              })
              .catch((err: unknown) => setError(message(err, "Not deleted.")));
          }}
        />
      )}
    </>
  );
}

// --- Style guide & rules ---------------------------------------------------------------------------

const EMOJIS: [VoiceEmojis, string][] = [
  ["none", "None"],
  ["one", "At most one"],
  ["any", "Any"],
];
const LINKS: [VoiceLinks, string][] = [
  ["never", "Never"],
  ["when_asked", "Only when they ask"],
  ["allowed", "Allowed"],
];

function GuideAndRules({ voice, onChanged }: { voice: Voice; onChanged: (v?: Voice) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(voice.guide);
  const [rules, setRules] = useState<VoiceRules>(voice.rules);
  const [maxWords, setMaxWords] = useState(voice.rules.max_words?.toString() ?? "");
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const manage = voice.can_manage;

  async function run(key: string, call: () => Promise<Voice>, done: string) {
    setBusy(key);
    setNotice(null);
    try {
      const next = await call();
      onChanged(next);
      setNotice({ kind: "success", text: done });
      return next;
    } catch (err) {
      setNotice({ kind: "error", text: message(err, "Not saved.") });
      return null;
    } finally {
      setBusy("");
    }
  }

  function addWord(event: FormEvent) {
    event.preventDefault();
    const value = word.trim();
    if (value && !rules.banned.includes(value))
      setRules({ ...rules, banned: [...rules.banned, value] });
    setWord("");
  }

  function saveRules() {
    const words = maxWords.trim() ? Number(maxWords) : null;
    void run(
      "rules",
      () => api.saveVoiceRules(voice.slug, { ...rules, max_words: words }),
      "Writing rules saved.",
    );
  }

  return (
    <>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      <div className="bv-grid">
        <section className="card stack" aria-labelledby="bv-guide">
          <div className="bv-card-head">
            <div>
              <h2 id="bv-guide">Style guide</h2>
              <p className="muted small">
                {voice.guide_edited
                  ? "Edited by the Owner. New examples won't overwrite it."
                  : voice.guide_at
                    ? `Written by the AI from the examples · updated ${formatDate(voice.guide_at)}`
                    : "Written by the AI after examples are uploaded."}
              </p>
            </div>
            {manage && !editing && (
              <button
                className="button button-small"
                onClick={() => {
                  setText(voice.guide);
                  setEditing(true);
                }}
              >
                Edit
              </button>
            )}
          </div>
          {editing ? (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  "guide",
                  () => api.saveVoiceGuide(voice.slug, text),
                  "Style guide saved.",
                ).then((next) => next && setEditing(false));
              }}
            >
              <label className="sr-only" htmlFor="bv-guide-text">
                Style guide text
              </label>
              <textarea
                id="bv-guide-text"
                className="textarea"
                rows={9}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="row">
                <button className="button button-primary" disabled={busy !== ""}>
                  Save
                </button>
                <button type="button" className="button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : voice.guide ? (
            <div className="pre bv-guide-text">{voice.guide}</div>
          ) : voice.from_file + voice.from_posted > 0 && !voice.guide_edited ? (
            <p className="muted">
              The style guide is being written from the examples. Check back in a minute.
            </p>
          ) : (
            <p className="muted">No style guide yet.</p>
          )}
          {manage && !editing && (
            <div className="row bv-rewrite">
              <button
                className="button"
                disabled={busy !== "" || voice.from_file + voice.from_posted === 0}
                onClick={() =>
                  voice.guide_edited
                    ? setConfirming(true)
                    : void run(
                        "rewrite",
                        () => api.rewriteVoiceGuide(voice.slug),
                        "The style guide was written again from the examples.",
                      )
                }
              >
                {busy === "rewrite" ? "Writing…" : "Rewrite from examples"}
              </button>
            </div>
          )}
        </section>

        <section className="card stack" aria-labelledby="bv-rules">
          <div>
            <h2 id="bv-rules">Writing rules</h2>
            <p className="muted small">
              Limits every {voice.name} draft follows, whatever the examples say.
            </p>
          </div>
          <fieldset className="bv-fieldset" disabled={!manage}>
            <div className="field">
              <label htmlFor="bv-max">Maximum length (words)</label>
              <input
                id="bv-max"
                className="input bv-short"
                type="number"
                min={10}
                max={1000}
                placeholder="No limit"
                value={maxWords}
                onChange={(e) => setMaxWords(e.target.value)}
              />
            </div>
            <div className="field">
              <span id="bv-emojis" className="bv-label">
                Emojis
              </span>
              <div className="bv-seg" role="group" aria-labelledby="bv-emojis">
                {EMOJIS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={rules.emojis === value}
                    onClick={() => setRules({ ...rules, emojis: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span id="bv-links" className="bv-label">
                Links
              </span>
              <div className="bv-seg" role="group" aria-labelledby="bv-links">
                {LINKS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={rules.links === value}
                    onClick={() => setRules({ ...rules, links: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="bv-disclosure">Disclosure line</label>
              <input
                id="bv-disclosure"
                className="input"
                value={rules.disclosure_line ?? ""}
                onChange={(e) => setRules({ ...rules, disclosure_line: e.target.value })}
              />
              <p className="hint">Added when a draft mentions GridRankers.</p>
            </div>
            <div className="field">
              <span id="bv-banned" className="bv-label">
                Words never to use
              </span>
              <ul className="bv-chips" aria-labelledby="bv-banned">
                {rules.banned.map((w) => (
                  <li key={w} className="bv-chip">
                    {w}
                    {manage && (
                      <button
                        type="button"
                        aria-label={`Remove ${w}`}
                        onClick={() =>
                          setRules({ ...rules, banned: rules.banned.filter((b) => b !== w) })
                        }
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
                {rules.banned.length === 0 && <li className="muted small">None yet.</li>}
              </ul>
            </div>
          </fieldset>
          {manage && (
            <>
              <form className="row" onSubmit={addWord}>
                <label className="sr-only" htmlFor="bv-word">
                  Add a word or phrase
                </label>
                <input
                  id="bv-word"
                  className="input grow"
                  placeholder="Add a word or phrase"
                  value={word}
                  onChange={(e) => setWord(e.target.value)}
                />
                <button className="button" disabled={!word.trim()}>
                  Add
                </button>
              </form>
              <div>
                <button
                  className="button button-primary"
                  disabled={busy !== ""}
                  onClick={saveRules}
                >
                  {busy === "rules" ? "Saving…" : "Save rules"}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {confirming && (
        <Confirm
          title="Rewrite the style guide?"
          message="The AI writes it again from the examples. Your edits to the guide are replaced."
          confirmLabel="Rewrite"
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void run(
              "rewrite",
              () => api.rewriteVoiceGuide(voice.slug),
              "The style guide was written again from the examples.",
            );
          }}
        />
      )}
    </>
  );
}

// --- Try it -----------------------------------------------------------------------------------------

function TryIt({ voice }: { voice: Voice }) {
  const [question, setQuestion] = useState("");
  const [group, setGroup] = useState("");
  const [result, setResult] = useState<VoiceTry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResult(await api.tryVoice(voice.slug, question, group.trim() || undefined));
    } catch (err) {
      setError(message(err, "No test draft."));
    } finally {
      setBusy(false);
    }
  }

  const checks = result?.checks;
  return (
    <div className="bv-grid bv-grid-try">
      <form className="card stack" onSubmit={submit} aria-labelledby="bv-ask">
        <div>
          <h2 id="bv-ask">Test a question</h2>
          <p className="muted small">
            See how a {voice.name} draft would sound right now. Nothing is saved or posted.
          </p>
        </div>
        <label htmlFor="bv-q">Their question</label>
        <textarea
          id="bv-q"
          className="textarea"
          rows={5}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <label htmlFor="bv-g">Group (optional)</label>
        <input
          id="bv-g"
          className="input"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        />
        {error && <Alert kind="error">{error}</Alert>}
        <div>
          <button className="button button-primary" disabled={busy || !question.trim()}>
            {busy ? "Writing…" : "Write a test draft"}
          </button>
        </div>
      </form>
      <section className="card stack" aria-labelledby="bv-result">
        <h2 id="bv-result">Test draft</h2>
        {!result && <p className="muted">The draft appears here.</p>}
        {result && checks && (
          <>
            <ul className="bv-checks" aria-label="Checks">
              <li className={checks.too_long ? "bad" : "good"}>
                {checks.words} words{checks.max_words ? ` · limit ${checks.max_words}` : ""}
              </li>
              <li className={checks.links ? "bad" : "good"}>
                {checks.links ? "Has a link" : "No links"}
              </li>
              <li className={checks.banned.length ? "bad" : "good"}>
                {checks.banned.length ? `Banned: ${checks.banned.join(", ")}` : "No banned words"}
              </li>
              {checks.emojis > 0 && (
                <li>
                  {checks.emojis} emoji{checks.emojis === 1 ? "" : "s"}
                </li>
              )}
            </ul>
            <div className="bubble bubble-us pre">{result.text}</div>
            <div className="stack-tight">
              <h3 className="bv-small-head">
                {result.matched
                  ? "Examples it copied the style from"
                  : "No close example: it used typical ones"}
              </h3>
              {result.examples.length === 0 && (
                <p className="muted small">No examples yet: only the style guide and rules.</p>
              )}
              {result.examples.map((e) => (
                <div key={e.id} className="bv-example">
                  <strong>{e.question}</strong>
                  <span className="muted small">{e.answer}</span>
                </div>
              ))}
            </div>
            {result.sources.length > 0 && (
              <p className="muted small">
                Facts from the Knowledge base: {result.sources.join(" · ")}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// --- To approve -------------------------------------------------------------------------------------

function Approve({ voice, onChanged }: { voice: Voice; onChanged: (v?: Voice) => void }) {
  const [items, setItems] = useState<VoiceExample[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .voiceExamples(voice.slug, "suggested")
      .then((list) => setItems(list.items))
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [voice.slug]);
  useEffect(load, [load]);

  async function decide(call: () => Promise<VoiceExample>) {
    setError("");
    try {
      const done = await call();
      setItems((list) => list && list.filter((e) => e.id !== done.id));
      setEditing(null);
      onChanged();
    } catch (err) {
      setError(message(err, "Not saved."));
    }
  }

  return (
    <div className="stack">
      <p className="muted">
        Replies your team posted on {voice.name}, suggested as new examples. Only approved ones
        teach the style.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      {items && items.length === 0 && <p className="muted">Nothing waiting.</p>}
      {items?.map((e) => (
        <article key={e.id} className="card stack bv-suggestion" aria-labelledby={`bv-s-${e.id}`}>
          <div className="bv-card-head">
            <strong id={`bv-s-${e.id}`}>{e.question}</strong>
            <span className="muted small">
              {e.created_by ? `Posted by ${e.created_by.name} · ` : ""}
              {formatDate(e.created_at)}
              {e.corrected && <span className="tag tag-warn">Corrected by a reviewer</span>}
            </span>
          </div>
          {editing === e.id ? (
            <>
              <label className="sr-only" htmlFor={`bv-edit-${e.id}`}>
                Answer
              </label>
              <textarea
                id={`bv-edit-${e.id}`}
                className="textarea"
                rows={4}
                value={text}
                onChange={(ev) => setText(ev.target.value)}
              />
            </>
          ) : (
            <div className="bubble bubble-us pre">{e.answer}</div>
          )}
          {voice.can_manage && (
            <div className="row">
              {editing === e.id ? (
                <>
                  <button
                    className="button button-primary"
                    disabled={!text.trim()}
                    onClick={() => void decide(() => api.approveVoiceExample(e.id, text))}
                  >
                    Save and approve
                  </button>
                  <button className="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="button button-primary"
                    onClick={() => void decide(() => api.approveVoiceExample(e.id))}
                  >
                    Approve
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      setText(e.answer);
                      setEditing(e.id);
                    }}
                  >
                    Edit, then approve
                  </button>
                  <button
                    className="button"
                    onClick={() => void decide(() => api.dismissVoiceExample(e.id))}
                  >
                    Dismiss
                  </button>
                </>
              )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
