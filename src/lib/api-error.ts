export async function readApiError(
  response: Response,
  fallbackMessage: string
) {
  try {
    const data = (await response.json()) as {
      error?: unknown
      errors?: unknown
    }

    if (typeof data.error === "string" && data.error.trim()) {
      return data.error
    }

    if (Array.isArray(data.errors)) {
      const errors = data.errors.filter(
        (error): error is string => typeof error === "string" && !!error.trim()
      )

      if (errors.length > 0) {
        return errors.join(" ")
      }
    }
  } catch {
    // Fall through to the generic HTTP error.
  }

  return `${fallbackMessage} Server responded with ${response.status}.`
}
