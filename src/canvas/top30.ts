import { z } from "zod";
import type { ResponseMode } from "./http";

const id = z.union([z.string().min(1), z.number().int()]).describe("Canvas ID.");
const userId = z.union([z.string().min(1), z.number().int()]).describe("Canvas user ID. Use self where accepted.");
const stringArray = z.array(z.string().min(1));
const page = z.number().int().min(1).optional();
const perPage = z.number().int().min(1).max(100).optional();
const include = stringArray.optional();

export type Top30ToolDefinition = {
  name: string;
  description: string;
  path: string;
  pathParams: string[];
  querySchema: Record<string, z.ZodType>;
  responseMode?: ResponseMode;
};

export const TOP_30_TOOLS = [
  {
    name: "list_courses",
    description:
      "List the current user's Canvas courses. Use this first to resolve a human course name or course code to the numeric Canvas course ID. Do not invent a sis_course_id from a display name. Defaults to per_page=100. Results include Canvas source links where available.",
    path: "/courses",
    pathParams: [],
    querySchema: {
      enrollment_state: z.enum(["active", "invited_or_pending", "completed"]).optional(),
      state: stringArray.optional(),
      include,
      page,
      per_page: perPage,
    },
  },
  {
    name: "get_course",
    description:
      "Get one Canvas course by numeric course ID returned by list_courses. Use sis_course_id:<value> only when Canvas explicitly returned that SIS ID; a course display name is not an SIS ID.",
    path: "/courses/{id}",
    pathParams: ["id"],
    querySchema: { include },
  },
  {
    name: "list_announcements",
    description: "List Canvas announcements for one or more course context codes.",
    path: "/announcements",
    pathParams: [],
    querySchema: {
      context_codes: stringArray.describe("Course context codes such as course_123."),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      active_only: z.boolean().optional(),
      latest_only: z.boolean().optional(),
      include,
      page,
      per_page: perPage,
    },
  },
  {
    name: "list_modules",
    description: "List modules in a Canvas course.",
    path: "/courses/{course_id}/modules",
    pathParams: ["course_id"],
    querySchema: {
      include,
      search_term: z.string().optional(),
      student_id: id.optional(),
      page,
      per_page: perPage,
    },
  },
  {
    name: "get_module",
    description: "Get one module in a Canvas course.",
    path: "/courses/{course_id}/modules/{id}",
    pathParams: ["course_id", "id"],
    querySchema: { include, student_id: id.optional() },
  },
  {
    name: "list_module_items",
    description: "List items inside a Canvas module.",
    path: "/courses/{course_id}/modules/{module_id}/items",
    pathParams: ["course_id", "module_id"],
    querySchema: { include, student_id: id.optional(), page, per_page: perPage },
  },
  {
    name: "get_module_item",
    description: "Get one item inside a Canvas module.",
    path: "/courses/{course_id}/modules/{module_id}/items/{id}",
    pathParams: ["course_id", "module_id", "id"],
    querySchema: { include, student_id: id.optional() },
  },
  {
    name: "list_assignments_for_course",
    description: "List assignments in a Canvas course. Defaults to per_page=100.",
    path: "/courses/{course_id}/assignments",
    pathParams: ["course_id"],
    querySchema: { page, per_page: perPage },
  },
  {
    name: "list_assignments_for_user_in_course",
    description: "List assignments for a Canvas user in a course. Use user_id='self' for the current user; numeric user IDs require explicit Canvas permission and must not be guessed.",
    path: "/users/{user_id}/courses/{course_id}/assignments",
    pathParams: ["user_id", "course_id"],
    querySchema: { page, per_page: perPage },
  },
  {
    name: "get_assignment",
    description: "Get one Canvas assignment.",
    path: "/courses/{course_id}/assignments/{id}",
    pathParams: ["course_id", "id"],
    querySchema: { include },
  },
  {
    name: "list_assignment_groups",
    description: "List assignment groups in a Canvas course.",
    path: "/courses/{course_id}/assignment_groups",
    pathParams: ["course_id"],
    querySchema: { include, page, per_page: perPage },
  },
  {
    name: "list_missing_submissions",
    description: "List missing submissions for a Canvas user. Use user_id=self for the current user.",
    path: "/users/{user_id}/missing_submissions",
    pathParams: ["user_id"],
    querySchema: { page, per_page: perPage },
  },
  {
    name: "list_upcoming_events",
    description: "List upcoming Canvas planner and calendar events.",
    path: "/users/self/upcoming_events",
    pathParams: [],
    querySchema: { page, per_page: perPage },
  },
  {
    name: "get_activity_stream",
    description: "Get the current user's global Canvas activity stream.",
    path: "/users/self/activity_stream",
    pathParams: [],
    querySchema: { only_active_courses: z.boolean().optional() },
  },
  {
    name: "list_pages",
    description: "List wiki pages in a Canvas course.",
    path: "/courses/{course_id}/pages",
    pathParams: ["course_id"],
    querySchema: { page, per_page: perPage },
  },
  {
    name: "get_page",
    description: "Get one Canvas wiki page by URL slug or ID.",
    path: "/courses/{course_id}/pages/{url_or_id}",
    pathParams: ["course_id", "url_or_id"],
    querySchema: {},
  },
  {
    name: "list_discussion_topics",
    description: "List discussion topics in a Canvas course. Use only_announcements=true for announcements view.",
    path: "/courses/{course_id}/discussion_topics",
    pathParams: ["course_id"],
    querySchema: {
      only_announcements: z.boolean().optional(),
      include: z.array(z.enum(["all_dates", "sections", "sections_user_count", "overrides"])).optional(),
      order_by: z.enum(["position", "recent_activity", "title"]).optional(),
      scope: z.enum(["locked", "unlocked", "pinned", "unpinned"]).optional(),
      search_term: z.string().optional(),
      page,
      per_page: perPage,
    },
  },
  {
    name: "get_discussion_topic_view",
    description: "Get a full Canvas discussion topic view.",
    path: "/courses/{course_id}/discussion_topics/{topic_id}/view",
    pathParams: ["course_id", "topic_id"],
    querySchema: { include_new_entries: z.boolean().optional() },
  },
  {
    name: "list_discussion_entries",
    description: "List entries for a Canvas discussion topic.",
    path: "/courses/{course_id}/discussion_topics/{topic_id}/entries",
    pathParams: ["course_id", "topic_id"],
    querySchema: { page, per_page: perPage },
  },
  {
    name: "list_course_files",
    description: "List files in a Canvas course.",
    path: "/courses/{course_id}/files",
    pathParams: ["course_id"],
    querySchema: {
      content_types: stringArray.optional(),
      search_term: z.string().optional(),
      include: stringArray.optional(),
      only: stringArray.optional(),
      sort: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page,
      per_page: perPage,
    },
  },
  {
    name: "get_course_file",
    description: "Get metadata for one Canvas course file.",
    path: "/courses/{course_id}/files/{id}",
    pathParams: ["course_id", "id"],
    querySchema: { include: stringArray.optional() },
  },
  {
    name: "get_file",
    description: "Get metadata for one Canvas file.",
    path: "/files/{id}",
    pathParams: ["id"],
    querySchema: { include: stringArray.optional() },
  },
  {
    name: "get_file_public_url",
    description: "Get Canvas public URL metadata for a file.",
    path: "/files/{id}/public_url",
    pathParams: ["id"],
    querySchema: {},
  },
  {
    name: "get_course_file_download",
    description: "Download a Canvas course file through the Canvas API. Binary responses are returned as base64 for compatibility; use get_canvas_file_content when a native MCP file/resource handle is preferable.",
    path: "/courses/{course_id}/files/{file_id}/download",
    pathParams: ["course_id", "file_id"],
    querySchema: {},
    responseMode: "base64" as const,
  },
  {
    name: "list_course_folders",
    description: "List folders in a Canvas course.",
    path: "/courses/{course_id}/folders",
    pathParams: ["course_id"],
    querySchema: { page, per_page: perPage },
  },
  {
    name: "list_files_in_folder",
    description: "List Canvas files in a folder.",
    path: "/folders/{folder_id}/files",
    pathParams: ["folder_id"],
    querySchema: { page, per_page: perPage },
  },
  {
    name: "list_course_users",
    description: "List users in a Canvas course.",
    path: "/courses/{course_id}/users",
    pathParams: ["course_id"],
    querySchema: {
      search_term: z.string().optional(),
      enrollment_type: stringArray.optional(),
      enrollment_role: stringArray.optional(),
      include: stringArray.optional(),
      user_id: userId.optional(),
      page,
      per_page: perPage,
    },
  },
  {
    name: "list_course_todo_items",
    description: "List course-specific Canvas todo items.",
    path: "/courses/{course_id}/todo",
    pathParams: ["course_id"],
    querySchema: { page, per_page: perPage },
  },
] satisfies Top30ToolDefinition[];

export const OLD_TOP_30_OPERATION_IDS = [
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
] as const;

export const CANVAS_TOOL_ALIASES = Object.freeze(
  Object.fromEntries(TOP_30_TOOLS.map((tool, index) => [OLD_TOP_30_OPERATION_IDS[index], tool.name])),
);
