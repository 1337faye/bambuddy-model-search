export type ModelProvider = 'makerworld' | 'printables';
export type ModelSort = 'trending' | 'popular' | 'newest' | 'relevance';

export interface ModelCard {
  provider: ModelProvider;
  id: string;
  title: string;
  url: string;
  creator: string;
  thumbnail: string | null;
  downloads: number | null;
  likes: number | null;
}

export interface ModelFile {
  id: string;
  name: string;
  format: string;
  size: number | null;
  sliceable: boolean;
  metadata: Record<string, unknown>;
}

export interface ModelDetail extends ModelCard {
  description_html: string;
  images: string[];
  license: string | null;
  files: ModelFile[];
  metadata: Record<string, unknown>;
}

export interface ModelsBrowseParams {
  query: string;
  sort: ModelSort;
  category: string;
  offset: number;
  limit: number;
}

export interface ModelsBrowseResponse {
  items: ModelCard[];
  has_more: boolean;
  total: number | null;
}

export interface PreparedModelFile {
  library_file_id: number;
  filename: string;
  folder_id: number | null;
  was_existing: boolean;
  temporary: boolean;
}
