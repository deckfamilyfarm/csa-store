export async function fetchCatalog() {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/catalog`);
  if (!response.ok) {
    throw new Error("Failed to load catalog");
  }
  return response.json();
}

export async function submitReview({ productId, rating, title, body }, token) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/reviews`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ productId, rating, title, body })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to submit review");
  }

  return response.json();
}

export async function fetchMyReviews(productId, token) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const url = new URL(`${base}/reviews/mine`, window.location.origin);
  if (productId) {
    url.searchParams.set("productId", String(productId));
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error("Unable to load reviews");
  }
  return response.json();
}

export async function updateReview(reviewId, payload, token) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/reviews/${reviewId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Unable to update review");
  }
  return response.json();
}

export async function deleteReview(reviewId, token) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/reviews/${reviewId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Unable to delete review");
  }
  return response.json();
}

export async function adminLogin(username, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) {
    throw new Error("Invalid credentials");
  }

  return response.json();
}

export async function userLogin(username, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) {
    throw new Error("Invalid credentials");
  }

  return response.json();
}

export async function requestPasswordReset(username) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to request password reset");
  }

  return response.json();
}

export async function resetPasswordWithToken(token, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to reset password");
  }

  return response.json();
}

export async function changePassword(token, currentPassword, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/change-password`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ currentPassword, password })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Unable to change password");
  }

  return response.json();
}

export async function fetchMe(token) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error("Unauthorized");
  }
  return response.json();
}
