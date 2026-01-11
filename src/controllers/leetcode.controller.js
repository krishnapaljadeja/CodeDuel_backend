const leetcodeService = require("../services/leetcode.service");
const { asyncHandler } = require("../middlewares/error.middleware");
const { body, validationResult } = require("express-validator");
const { encrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

/**
 * Validation for storing LeetCode session
 */
const validateStoreSession = [
  body("cookie")
    .notEmpty()
    .withMessage("LeetCode session cookie is required")
    .isString()
    .withMessage("Cookie must be a string"),
  body("csrfToken")
    .optional()
    .isString()
    .withMessage("CSRF token must be a string"),
  body("expiresAt")
    .optional()
    .isISO8601()
    .withMessage("Expires at must be a valid ISO date"),
];

/**
 * Store LeetCode session for current user
 * POST /api/leetcode/session
 *
 * @body {string} cookie - LEETCODE_SESSION cookie value
 * @body {string} csrfToken - Optional CSRF token
 * @body {string} expiresAt - Optional expiration date (ISO format)
 */
const storeSession = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: errors.array(),
    });
  }

  const { cookie, csrfToken, expiresAt } = req.body;
  const userId = req.user.id;
  const leetcodeUsername = req.user.leetcodeUsername;

  // Validate session before storing
  try {
    const isValid = await leetcodeService.validateSession(
      encrypt(JSON.stringify({ cookie, csrfToken })),
      leetcodeUsername
    );

    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: "Invalid LeetCode session. Please check your credentials.",
      });
    }
  } catch (error) {
    logger.warn("Session validation failed:", error.message);
    // Continue anyway - session might be valid but validation query failed
  }

  const session = await leetcodeService.storeUserSession(
    userId,
    { cookie, csrfToken },
    expiresAt ? new Date(expiresAt) : null
  );

  res.status(201).json({
    success: true,
    message: "LeetCode session stored successfully",
    data: session,
  });
});

/**
 * Get session status for current user
 * GET /api/leetcode/session
 */
const getSessionStatus = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const sessionData = await leetcodeService.getUserSession(userId);

  if (!sessionData) {
    return res.status(200).json({
      success: true,
      data: {
        hasSession: false,
        message: "No active session found",
      },
    });
  }

  // Check if session is still valid
  const isValid = await leetcodeService.validateSession(sessionData);

  res.status(200).json({
    success: true,
    data: {
      hasSession: true,
      isValid,
      message: isValid
        ? "Session is active and valid"
        : "Session exists but may be expired",
    },
  });
});

/**
 * Invalidate (remove) LeetCode session for current user
 * DELETE /api/leetcode/session
 */
const invalidateSession = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  await leetcodeService.invalidateUserSession(userId);

  res.status(200).json({
    success: true,
    message: "LeetCode session invalidated successfully",
  });
});

/**
 * Fetch user's LeetCode profile
 * GET /api/leetcode/profile/:username
 */
const getUserProfile = asyncHandler(async (req, res) => {
  const { username } = req.params;
  
  const profile = await leetcodeService.fetchUserProfile(username);

  res.status(200).json({
    success: true,
    data: profile,
  });
});

/**
 * Test LeetCode connection (for debugging)
 * GET /api/leetcode/test/:username
 */
const testConnection = asyncHandler(async (req, res) => {
  const { username } = req.params;

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const submissions = await leetcodeService.fetchSubmissionsForDate(username);

  res.status(200).json({
    success: true,
    message: "Connection test successful",
    data: {
      username,
      hasSession: true,
      submissionsFound: submissions.length,
      submissions: submissions// Return first 5 for testing
    },
  });
});

/**
 * Fetch problem metadata (for admin/debugging)
 * GET /api/leetcode/problem/:titleSlug
 */
const getProblemMetadata = asyncHandler(async (req, res) => {
  const { titleSlug } = req.params;
  const userId = req.user.id;

  const sessionData = await leetcodeService.getUserSession(userId);

  const metadata = await leetcodeService.fetchProblemMetadata(
    titleSlug,
    sessionData
  );

  if (!metadata) {
    return res.status(404).json({
      success: false,
      message: `Problem not found: ${titleSlug}`,
    });
  }

  res.status(200).json({
    success: true,
    data: metadata,
  });
});

module.exports = {
  storeSession,
  getSessionStatus,
  invalidateSession,
  getUserProfile,
  testConnection,
  getProblemMetadata,
  validateStoreSession,
};
