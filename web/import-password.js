// A statement the bank locked with a password stays in the import inbox until
// it is read or removed. A wrong or cancelled password is never terminal: the
// entry keeps the same locked state, so the retry action is offered again no
// matter how many times the password was wrong. Nothing here counts attempts.

export const PDF_PASSWORD_WRONG =
  "That password did not open this PDF. Try again, or remove the file.";
export const PDF_PASSWORD_CANCELLED = "No password entered. Nothing was read.";

// Map a failed read to what the entry shows. An ordinary read error returns
// null and is left to the caller; only the password gate keeps its own state.
export function passwordFailure(error) {
  const wrong = Boolean(error && error.wrong);
  const cancelled = Boolean(error && error.cancelled);
  if (!wrong && !cancelled) return null;
  return {
    status: "locked",
    wrong,
    message: wrong ? PDF_PASSWORD_WRONG : PDF_PASSWORD_CANCELLED,
  };
}

export function offersPasswordRetry(entry) {
  return Boolean(entry) && entry.status === "locked";
}
