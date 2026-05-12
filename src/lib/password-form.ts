export function clearPasswordInputs(form: HTMLFormElement) {
  for (const element of Array.from(form.elements)) {
    if (element instanceof HTMLInputElement && element.type === "password") {
      element.value = ""
    }
  }
}
