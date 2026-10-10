import { describe, expect, it } from "vitest";
import { OLD_TOP_30_OPERATION_IDS, TOP_30_TOOLS } from "../src/canvas/top30";

const expectedOldTop30 = [
  "listCourses",
  "getCourse",
  "listAnnouncements",
  "listModules",
  "getModule",
  "listModuleItems",
  "getModuleItem",
  "listAssignmentsForCourse",
  "listAssignmentsForUserInCourse",
  "getAssignment",
  "listAssignmentGroups",
  "listMissingSubmissions",
  "listUpcomingEvents",
  "getActivityStream",
  "listPages",
  "getPage",
  "listDiscussionTopics",
  "getDiscussionTopicView",
  "listDiscussionEntries",
  "listCourseFiles",
  "getCourseFile",
  "getFile",
  "getFilePublicUrl",
  "getCourseFileDownload",
  "listCourseFolders",
  "listFilesInFolder",
  "listCourseUsers",
  "listCourseTodoItems",
];

describe("curated Canvas course tools", () => {
  it("registers every supported legacy operation ID as a curated MCP tool", () => {
    expect(OLD_TOP_30_OPERATION_IDS).toEqual(expectedOldTop30);
    expect(new Set(OLD_TOP_30_OPERATION_IDS).size).toBe(28);
    expect(TOP_30_TOOLS.some((tool) => tool.name === "get_course_timetable")).toBe(false);
    expect(TOP_30_TOOLS.some((tool) => tool.name === "get_course_user_progress")).toBe(false);
  });

  it("steers human course names through list_courses before get_course", () => {
    const listCourses = TOP_30_TOOLS.find((tool) => tool.name === "list_courses");
    const getCourse = TOP_30_TOOLS.find((tool) => tool.name === "get_course");

    expect(listCourses?.description).toContain("resolve a human course name");
    expect(listCourses?.description).toContain("Do not invent a sis_course_id");
    expect(getCourse?.description).toContain("numeric course ID returned by list_courses");
  });
});
