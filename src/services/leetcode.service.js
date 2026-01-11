const axios = require("axios");
const { config } = require("../config/env");
const { prisma } = require("../config/prisma");
const { encrypt, decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

const {
  RECENT_SUBMISSIONS_QUERY,
  PROBLEM_DETAILS_QUERY,
  USER_CALENDAR_QUERY,
  USER_SUBMISSIONS_QUERY,
} = require("../utils/leetcode.queries");

/**
 * Fetch LeetCode submissions for a user
 * @param {string} leetcodeUsername - LeetCode username
 * @param {Date} startDate - Start date for filtering
 * @param {Date} endDate - End date for filtering
 * @param {string} sessionData - Optional encrypted session data
 * @returns {Array} Array of submissions
 */
const fetchUserSubmissions = async (leetcodeUsername) => {

  try {
    // Fetch recent submissions (up to 10)
    const response = await axios.post(
      config.leetcodeGraphqlUrl,
      {
        query: RECENT_SUBMISSIONS_QUERY,
        variables: {
          username: leetcodeUsername,
          limit: 10,
        },
      },
    );

    if (!response.data || !response.data.data) {
      logger.warn(`No data returned for user: ${leetcodeUsername}`);
      return [];
    }

    const submissions = response.data.data.recentAcSubmissionList || [];

    logger.debug(
      `Fetched ${submissions.length} submissions for ${leetcodeUsername}`
    );

    return submissions;
  } catch (error) {
    // Handle rate limiting or network errors gracefully
    if (error.response && error.response.status === 429) {
      logger.error("LeetCode API rate limit exceeded");
      throw new Error("Rate limit exceeded. Please try again later.");
    }

    logger.error("Error fetching LeetCode submissions:", error.message);
    throw new Error("Failed to fetch LeetCode submissions");
  }
};

/**
 * Parse submissions to extract difficulty and other metadata
 * Note: LeetCode API doesn't directly provide difficulty in submission data
 * This is a placeholder - in production, you might need to:
 * 1. Maintain a local cache of problem metadata
 * 2. Make additional API calls to fetch problem details
 * 3. Use web scraping (not recommended)
 *
 * @param {Array} submissions - Raw submissions from LeetCode
 * @returns {Array} Parsed submissions with metadata
 */
const parseSubmissions = async (submissions) => {
  // For now, we'll return submissions as-is
  // In production, you would enrich this data with problem difficulty
  return submissions.map((sub) => ({
    id: sub.id,
    title: sub.title,
    titleSlug: sub.titleSlug,
    timestamp: new Date(parseInt(sub.timestamp) * 1000),
    status: sub.statusDisplay,
    language: sub.lang,
    // Difficulty would be fetched from a separate source
    difficulty: null, // TODO: Implement difficulty fetching
  }));
};

/**
 * Get or fetch LeetCode session for a user
 * @param {string} userId - User ID
 * @returns {string|null} Encrypted session data or null
 */
const getUserSession = async (userId) => {
  const session = await prisma.leetCodeSession.findFirst({
    where: {
      userId,
      isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: {
      lastUsedAt: "desc",
    },
  });

  if (session) {
    // Update last used timestamp
    await prisma.leetCodeSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });

    return session.sessionData;
  }

  return null;
};

/**
 * Store LeetCode session for a user (encrypted)
 * @param {string} userId - User ID
 * @param {Object} sessionData - Session data to store
 * @param {Date} expiresAt - Optional expiration date
 * @returns {Object} Created session record
 */
const storeUserSession = async (userId, sessionData, expiresAt = null) => {
  const encryptedData = encrypt(JSON.stringify(sessionData));

  // Deactivate old sessions
  await prisma.leetCodeSession.updateMany({
    where: { userId },
    data: { isActive: false },
  });

  // Create new session
  const session = await prisma.leetCodeSession.create({
    data: {
      userId,
      sessionData: encryptedData,
      csrfToken: sessionData.csrfToken ? encrypt(sessionData.csrfToken) : null,
      expiresAt,
    },
  });

  logger.info(`LeetCode session stored for user: ${userId}`);

  return session;
};

/**
 * Fetch submissions for a specific date (helper function)
 * @param {string} leetcodeUsername - LeetCode username
 * @param {Date} date - Date to fetch submissions for
 * @param {string} sessionData - Optional session data
 * @returns {Array} Submissions for the date
 */
const fetchSubmissionsForDate = async (leetcodeUsername) => {

  return await fetchUserSubmissions(
    leetcodeUsername,
  );
};

/**
 * Core function to make GraphQL requests to LeetCode
 * Handles session cookies, CSRF tokens, and error handling
 *
 * @param {string} query - GraphQL query string
 * @param {Object} variables - Query variables
 * @param {string|null} sessionData - Encrypted session data
 * @returns {Promise<Object>} GraphQL response data
 */
const fetchLeetCodeData = async (query, variables) => {
  try {
    // Make GraphQL request
    const response = await axios.post(
      config.leetcodeGraphqlUrl || "https://leetcode.com/graphql/",
      { query, variables }
    );

    // Check for GraphQL errors
    if (response.data.errors) {
      logger.error("GraphQL errors:", response.data.errors);
      throw new Error(`GraphQL Error: ${response.data.errors[0].message}`);
    }

    if (!response.data || !response.data.data) {
      logger.warn("No data returned from LeetCode GraphQL");
      return null;
    }

    return response.data.data;
  } catch (error) {
    // Enhanced error handling
    if (error.response) {
      const status = error.response.status;
      if (status === 429) {
        throw new Error("Rate limit exceeded. Please try again later.");
      } else if (status === 401 || status === 403) {
        throw new Error("Authentication failed. Session may be expired.");
      } else if (status === 404) {
        throw new Error("Resource not found.");
      }
    }

    if (error.code === "ECONNABORTED") {
      throw new Error("Request timeout.");
    }

    logger.error("Error fetching LeetCode data:", error.message);
    throw error;
  }
};

/**
 * Fetch problem metadata (including difficulty) from cache or LeetCode API
 * Uses local cache to minimize API calls
 *
 * @param {string} titleSlug - Problem title slug (e.g., "two-sum")
 * @param {string|null} sessionData - Optional session data
 * @returns {Promise<Object>} Problem metadata including difficulty
 */
const fetchProblemMetadata = async (titleSlug, sessionData = null) => {
  try {
    // Check cache first (if data is less than 7 days old)
    const cachedProblem = await prisma.problemMetadata.findUnique({
      where: { titleSlug },
    });

    const cacheExpiryDays = 7;
    const now = new Date();

    if (cachedProblem) {
      const daysSinceUpdate =
        (now - cachedProblem.lastFetchedAt) / (1000 * 60 * 60 * 24);

      if (daysSinceUpdate < cacheExpiryDays) {
        logger.debug(`Using cached metadata for problem: ${titleSlug}`);
        return cachedProblem;
      }
    }

    // Fetch from LeetCode API
    logger.debug(`Fetching fresh metadata for problem: ${titleSlug}`);

    const data = await fetchLeetCodeData(
      PROBLEM_DETAILS_QUERY,
      { titleSlug },
      sessionData
    );

    if (!data || !data.question) {
      logger.warn(`No problem data found for: ${titleSlug}`);
      return cachedProblem || null;
    }

    const problem = data.question;

    // Extract topic tags
    const topicTags = problem.topicTags
      ? problem.topicTags.map((tag) => tag.name)
      : [];

    // Prepare metadata object
    const metadata = {
      titleSlug: problem.titleSlug,
      questionId: problem.questionId,
      title: problem.title,
      difficulty: problem.difficulty,
      acRate: problem.acRate ? parseFloat(problem.acRate) : null,
      likes: problem.likes || 0,
      dislikes: problem.dislikes || 0,
      isPaidOnly: problem.isPaidOnly || false,
      topicTags,
      lastFetchedAt: now,
    };

    // Upsert to cache
    const savedMetadata = await prisma.problemMetadata.upsert({
      where: { titleSlug },
      update: { ...metadata, updatedAt: now },
      create: metadata,
    });

    logger.info(
      `Cached metadata for problem: ${titleSlug} (${problem.difficulty})`
    );

    return savedMetadata;
  } catch (error) {
    logger.error(`Failed to fetch metadata for ${titleSlug}:`, error.message);
    return cachedProblem || null;
  }
};

/**
 * Enrich submissions with problem metadata (difficulty, etc.)
 *
 * @param {Array} submissions - Raw submissions from LeetCode
 * @param {string|null} sessionData - Optional session data
 * @returns {Promise<Array>} Enriched submissions with difficulty
 */
const enrichSubmissionsWithMetadata = async (
  submissions,
  sessionData = null
) => {
  const enrichedSubmissions = [];

  for (const submission of submissions) {
    try {
      const metadata = await fetchProblemMetadata(
        submission.titleSlug,
        sessionData
      );

      enrichedSubmissions.push({
        id: submission.id,
        title: submission.title,
        titleSlug: submission.titleSlug,
        timestamp: new Date(parseInt(submission.timestamp) * 1000),
        status: submission.statusDisplay,
        language: submission.lang,
        difficulty: metadata ? metadata.difficulty : "Unknown",
        questionId: metadata ? metadata.questionId : null,
        isPaidOnly: metadata ? metadata.isPaidOnly : false,
        topicTags: metadata ? metadata.topicTags : [],
      });
    } catch (error) {
      logger.warn(
        `Failed to enrich submission ${submission.titleSlug}:`,
        error.message
      );
      enrichedSubmissions.push({
        id: submission.id,
        title: submission.title,
        titleSlug: submission.titleSlug,
        timestamp: new Date(parseInt(submission.timestamp) * 1000),
        status: submission.statusDisplay,
        language: submission.lang,
        difficulty: "Unknown",
      });
    }
  }

  return enrichedSubmissions;
};

/**
 * Validate if a session is still working
 *
 * @param {string} sessionData - Encrypted session data
 * @returns {Promise<boolean>} True if session is valid
 */
const validateSession = async (sessionData , leetcodeUsername) => {
  try {
    const data = await fetchLeetCodeData(
      USER_CALENDAR_QUERY,
      { username: leetcodeUsername, year: new Date().getFullYear() },
      sessionData
    );
    console.log(data);
    console.log('tr' , !!data)
    return !!data;
  } catch (error) {
    logger.warn("Session validation failed:", error.message);
    return false;
  }
};

/**
 * Invalidate (deactivate) a user's LeetCode session
 *
 * @param {string} userId - User ID
 */
const invalidateUserSession = async (userId) => {
  await prisma.leetCodeSession.updateMany({
    where: { userId },
    data: { isActive: false },
  });
  logger.info(`Invalidated LeetCode session for user: ${userId}`);
};

/**
 * Fetch user profile statistics from LeetCode
 *
 * @param {string} username - LeetCode username
 * @param {string|null} sessionData - Optional session data
 * @returns {Promise<Object>} User statistics
 */
const fetchUserProfile = async (username) => {
  try {
    const currentYear = new Date().getFullYear();
    const data = await fetchLeetCodeData(
      USER_CALENDAR_QUERY,
      { username, year: currentYear }
    );

    if (!data || !data.matchedUser) {
      throw new Error("User not found");
    }

    const calendar = data.matchedUser.userCalendar;

    return {
      username,
      streak: calendar.streak || 0,
      totalActiveDays: calendar.totalActiveDays || 0,
      activeYears: calendar.activeYears || [],
      submissionCalendar: calendar.submissionCalendar
        ? JSON.parse(calendar.submissionCalendar)
        : {},
    };
  } catch (error) {
    logger.error(`Failed to fetch profile for ${username}:`, error.message);
    throw error;
  }
};

module.exports = {
  // Core functions
  fetchLeetCodeData,
  fetchUserSubmissions,
  fetchSubmissionsForDate,
  fetchProblemMetadata,
  enrichSubmissionsWithMetadata,
  parseSubmissions,

  // Session management
  getUserSession,
  storeUserSession,
  validateSession,
  invalidateUserSession,

  // Additional features
  fetchUserProfile,

  // GraphQL queries (exported for reference/testing)
  RECENT_SUBMISSIONS_QUERY,
  PROBLEM_DETAILS_QUERY,
  USER_CALENDAR_QUERY,
  USER_SUBMISSIONS_QUERY,
};
