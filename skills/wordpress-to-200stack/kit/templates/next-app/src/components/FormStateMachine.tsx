"use client";

import { FormEvent, useMemo, useRef, useState } from "react";

export type FormField = {
  name: string;
  label: string;
  type: "text" | "email" | "tel" | "textarea" | "select" | "hidden";
  required?: boolean;
  options?: ReadonlyArray<{ label: string; value: string }>;
};

type FormState = "input" | "confirm" | "submitting" | "complete" | "error";

export function FormStateMachine({ action, fields, submitLabel = "送信する" }: {
  action: string;
  fields: readonly FormField[];
  submitLabel?: string;
}) {
  const initialValues = useMemo(() => Object.fromEntries(fields.map((field) => [field.name, ""])) as Record<string, string>, [fields]);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [state, setState] = useState<FormState>("input");
  const [error, setError] = useState<string>();
  const submitting = useRef(false);

  function update(name: string, value: string) { setValues((current) => ({ ...current, [name]: value })); }
  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    setError(undefined);
    setState("confirm");
  }
  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    setState("submitting");
    setError(undefined);
    try {
      const response = await fetch(action, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams(values).toString(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setState("complete");
    } catch {
      setError("送信に失敗しました。時間をおいてもう一度お試しください。");
      setState("error");
    } finally {
      submitting.current = false;
    }
  }

  if (state === "complete") return <p role="status" data-testid="form-complete">送信を受け付けました。</p>;
  if (state === "confirm" || state === "submitting" || state === "error") return (
    <section data-testid="form-confirm">
      <dl>{fields.filter((field) => field.type !== "hidden").map((field) => <div key={field.name}><dt>{field.label}</dt><dd>{values[field.name]}</dd></div>)}</dl>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => setState("input")} disabled={state === "submitting"}>入力へ戻る</button>
      <button type="button" onClick={submit} disabled={state === "submitting"}>{state === "submitting" ? "送信中…" : submitLabel}</button>
    </section>
  );

  return <form onSubmit={confirm} data-testid="form-input">
    {fields.map((field) => <label key={field.name}>
      {field.type !== "hidden" && field.label}
      {field.type === "textarea" ? <textarea name={field.name} required={field.required} value={values[field.name] ?? ""} onChange={(event) => update(field.name, event.target.value)} />
        : field.type === "select" ? <select name={field.name} required={field.required} value={values[field.name] ?? ""} onChange={(event) => update(field.name, event.target.value)}><option value="">選択してください</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : <input name={field.name} type={field.type} required={field.required} value={values[field.name] ?? ""} onChange={(event) => update(field.name, event.target.value)} />}
    </label>)}
    <button type="submit">確認する</button>
  </form>;
}
