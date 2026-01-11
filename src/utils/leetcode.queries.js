// Centralized LeetCode GraphQL queries

const RECENT_SUBMISSIONS_QUERY = `
  query recentAcSubmissions($username: String!, $limit: Int!) {
    recentAcSubmissionList(username: $username, limit: $limit) {
      id
      title
      titleSlug
      timestamp
      statusDisplay
      lang
    }
  }
`;

const PROBLEM_DETAILS_QUERY = `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionId
      questionFrontendId
      title
      titleSlug
      difficulty
      likes
      dislikes
      isPaidOnly
      acRate
      topicTags {
        name
        slug
      }
    }
  }
`;

const USER_CALENDAR_QUERY = `
  query userProfileCalendar($username: String!, $year: Int!) {
    matchedUser(username: $username) {
      userCalendar(year: $year) {
        activeYears
        streak
        totalActiveDays
        submissionCalendar
      }
    }
  }
`;

const USER_SUBMISSIONS_QUERY = `
  query userSubmissions($username: String!, $offset: Int!, $limit: Int!) {
    recentSubmissionList(username: $username, offset: $offset, limit: $limit) {
      title
      titleSlug
      timestamp
      statusDisplay
      lang
      runtime
      memory
    }
  }
`;

module.exports = {
  RECENT_SUBMISSIONS_QUERY,
  PROBLEM_DETAILS_QUERY,
  USER_CALENDAR_QUERY,
  USER_SUBMISSIONS_QUERY,
};
