export function Placeholder({ title, step }: { title: string; step: number }) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <div className="card empty">
        <p>This screen arrives in build step {step}.</p>
      </div>
    </section>
  );
}
