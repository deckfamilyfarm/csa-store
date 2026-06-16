const base = import.meta.env.VITE_API_BASE || "/api";
const inflightGetRequests = new Map();
const DEFAULT_POST_TIMEOUT_MS = 20000;

function getRequestKey(url, token = "") {
  return `${url}::${token}`;
}

async function throwForError(response, fallbackMessage) {
  let detail = "";
  try {
    const payload = await response.json();
    detail = payload?.detail || payload?.error || "";
  } catch (error) {
    try {
      detail = (await response.text()) || "";
    } catch (textError) {
      detail = "";
    }
  }

  const error = new Error(detail || fallbackMessage);
  error.status = response.status;
  throw error;
}

async function fetchJsonGet(url, token, fallbackMessage) {
  const requestKey = getRequestKey(url, token);
  if (inflightGetRequests.has(requestKey)) {
    return inflightGetRequests.get(requestKey);
  }

  const requestPromise = (async () => {
    const response = await fetch(url, {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    });
    if (!response.ok) await throwForError(response, fallbackMessage);
    return response.json();
  })();

  inflightGetRequests.set(requestKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    inflightGetRequests.delete(requestKey);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_POST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Lookup timed out. Please try again.");
      timeoutError.status = 408;
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchCatalog() {
  return fetchJsonGet(`${base}/catalog`, "", "Failed to load catalog");
}

export async function fetchSiteContent() {
  return fetchJsonGet(`${base}/site-content`, "", "Failed to load site content");
}

export async function fetchDropSites() {
  return fetchJsonGet(`${base}/drop-sites`, "", "Failed to load drop sites");
}

export async function fetchDropSitePerformance(month = "") {
  const url = new URL(`${base}/dropsites/performance`, window.location.origin);
  if (month) {
    url.searchParams.set("month", month);
  }
  return fetchJsonGet(url.toString(), "", "Failed to load drop-site performance");
}

export async function fetchDropSiteShareLinks() {
  return fetchJsonGet(
    `${base}/marketing/dropsite-share-links`,
    "",
    "Failed to load drop-site share links"
  );
}

export async function submitDropSiteHostInterest(formData) {
  const response = await fetch(`${base}/dropsites/host-interest`, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    await throwForError(response, "Unable to submit drop-site host interest");
  }

  return response.json();
}

export async function submitSubscribeLead(payload) {
  const response = await fetch(`${base}/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });

  if (!response.ok) {
    await throwForError(response, "Unable to submit subscribe request");
  }

  return response.json();
}

export async function fetchLiabilityReleaseTemplate(slug) {
  return fetchJsonGet(
    `${base}/liability/templates/${encodeURIComponent(slug)}`,
    "",
    "Failed to load liability release"
  );
}

export async function submitLiabilityRelease(slug, payload) {
  const response = await fetch(`${base}/liability/sign/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });

  if (!response.ok) {
    await throwForError(response, "Unable to submit liability release");
  }

  return response.json();
}

export async function fetchSubscribeAddressInsights(payload) {
  const response = await fetchWithTimeout(`${base}/subscribe/address-insights`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });

  if (!response.ok) {
    await throwForError(response, "Unable to validate address");
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
  const url = new URL(`${base}/reviews/mine`, window.location.origin);
  if (productId) {
    url.searchParams.set("productId", String(productId));
  }
  return fetchJsonGet(url.toString(), token, "Unable to load reviews");
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

  if (!response.ok) await throwForError(response, "Invalid credentials");

  return response.json();
}

export async function userLogin(username, password) {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) await throwForError(response, "Invalid credentials");

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
  return fetchJsonGet(`${base}/auth/me`, token, "Unauthorized");
}

export async function fetchMemberPortal(token) {
  return fetchJsonGet(`${base}/member/portal`, token, "Unable to load member portal");
}

export async function createMemberSetupIntent(token) {
  const response = await fetch(`${base}/member/setup-intent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  if (!response.ok) await throwForError(response, "Unable to create payment setup intent");
  return response.json();
}

export async function setMemberPaymentMethodDefault(token, paymentMethodId) {
  const response = await fetch(`${base}/member/payment-method/default`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ paymentMethodId })
  });
  if (!response.ok) await throwForError(response, "Unable to set default payment method");
  return response.json();
}

export async function deleteMemberPaymentMethod(token, paymentMethodId) {
  const response = await fetch(`${base}/member/payment-method/delete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ paymentMethodId })
  });
  if (!response.ok) await throwForError(response, "Unable to delete payment method");
  return response.json();
}

export async function updateMemberSubscription(token, payload) {
  const response = await fetch(`${base}/member/subscription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });
  if (!response.ok) await throwForError(response, "Unable to update subscription");
  return response.json();
}

export async function pauseMemberSubscription(token) {
  const response = await fetch(`${base}/member/subscription/pause`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  if (!response.ok) await throwForError(response, "Unable to pause subscription");
  return response.json();
}

export async function resumeMemberSubscription(token) {
  const response = await fetch(`${base}/member/subscription/resume`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  if (!response.ok) await throwForError(response, "Unable to resume subscription");
  return response.json();
}

export async function cancelMemberSubscription(token) {
  const response = await fetch(`${base}/member/subscription/cancel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  if (!response.ok) await throwForError(response, "Unable to cancel subscription");
  return response.json();
}

export async function fetchMemberLocalLineLink(token) {
  return fetchJsonGet(`${base}/member/localline-link`, token, "Unable to load Local Line link");
}

export async function loginMemberLocalLine(token, payload) {
  const response = await fetch(`${base}/member/localline/login`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });
  if (!response.ok) await throwForError(response, "Unable to connect your Local Line account");
  return response.json();
}

export async function requestMemberLocalLineCreate(token, payload) {
  const response = await fetch(`${base}/member/localline/request-create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });
  if (!response.ok) await throwForError(response, "Unable to save your Local Line setup request");
  return response.json();
}

export async function fetchMemberLocalLineCustomer(token) {
  return fetchJsonGet(
    `${base}/member/localline/customer`,
    token,
    "Unable to load Local Line customer"
  );
}

export async function fetchMemberLocalLineCredit(token, page = 1, pageSize = 25) {
  const url = new URL(`${base}/member/localline/credit`, window.location.origin);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(pageSize));
  return fetchJsonGet(url.toString(), token, "Unable to load Local Line credit");
}

export async function importMemberLocalLineLedger(token) {
  const response = await fetch(`${base}/member/localline/import-ledger`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  if (!response.ok) await throwForError(response, "Unable to import Local Line ledger activity");
  return response.json();
}

export async function saveMemberLocalLineLink(token, payload) {
  const response = await fetch(`${base}/member/localline-link`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });
  if (!response.ok) await throwForError(response, "Unable to save Local Line link");
  return response.json();
}
