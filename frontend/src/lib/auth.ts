"use client";

import { useEffect, useState } from "react";
import { api, User } from "./api";

export async function fetchMe(): Promise<User | null> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/auth/me`, {
      credentials: "include",
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function login(username: string, password: string): Promise<User> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new Error(detail ?? `Login failed (${res.status})`);
  }
  return res.json();
}

export async function logout(): Promise<void> {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/login";
}

export function useMe(): { me: User | null; loading: boolean } {
  const [me, setMe] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetchMe().then((u) => { setMe(u); setLoading(false); });
  }, []);
  return { me, loading };
}
