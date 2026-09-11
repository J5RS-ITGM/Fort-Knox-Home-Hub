"use client";

import { Component, ReactNode } from "react";

/** Minimal error boundary. Wraps chrome (like the header) so a render
 *  error there degrades to nothing instead of taking down the whole page
 *  with a client-side exception. */
export default class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error("UI subtree error:", err);
  }
  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
