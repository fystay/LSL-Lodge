/** Result of a sign-in form submission, shown in place by the form. */
export interface AuthFormState {
  status: "idle" | "error" | "info";
  message?: string;
  /** Echoed back so an error never clears the email address. */
  email?: string;
}

export const IDLE: AuthFormState = { status: "idle" };
