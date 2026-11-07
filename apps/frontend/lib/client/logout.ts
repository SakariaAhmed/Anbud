"use client";

export async function logOutAndRedirect(
  redirect: () => void = () => window.location.assign("/login"),
) {
  const response = await fetch("/api/auth/logout", { method: "POST" });
  if (!response.ok) {
    throw new Error("Kunne ikke logge ut. Prøv igjen.");
  }
  redirect();
}
