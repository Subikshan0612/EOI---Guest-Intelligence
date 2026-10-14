import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { rememberIntendedPath } from "../../features/auth/intendedPath";
import ForgotPasswordPage from "./ForgotPasswordPage";
import SignInPage from "./SignInPage";
import SignUpPage from "./SignUpPage";

/**
 * What a signed-out person can reach (unified EOI session): /signin, /signup, /forgot-password. Any other address - a deep link into the application, an old bookmark -
 * is remembered (memory only, same-origin paths only) and sent to /signin, and after signing in the person is taken to it. (/verify-email and /reset-password are public
 * pages that work signed in or out; App.jsx serves them before this.)
 */
export default function AuthRoutes() {
  const location = useLocation();
  useEffect(() => {
    rememberIntendedPath(`${location.pathname}${location.search}${location.hash}`);
  }, [location]);
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route path="/signup" element={<SignUpPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="*" element={<Navigate to="/signin" replace />} />
    </Routes>
  );
}
