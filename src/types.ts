export interface PostSummary {
  id: string;
  title: string;
  author: string;
  replyCount: number;
  time: string;
}
export interface ZonePage {
  posts: PostSummary[];
  nextCursor: string;
}
export interface Comment {
  id: string;
  author: string;
  time: string;
  content: string;
  likes: number;
}
export interface Post {
  id: string;
  title: string;
  author: string;
  time: string;
  content: string;
  comments: Comment[];
  hasMore: boolean;
}
