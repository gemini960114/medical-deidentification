/** Browser/server contract. No endpoint URL or provider credentials belong here. */
export interface ModelFinding { category: string; value: string; reason: string; page?: number; source: 'text' | 'vision'; }
export interface ModelPage { page: number; dataUrl: string; }
export interface ModelRequest { text: string; model: string; vision: boolean; pages?: ModelPage[]; }
export interface ModelResponse { model: string; textCompleted: true; visionCompleted: boolean; findings: ModelFinding[]; }
export interface ModelSettings { models: string[]; defaultModel: string; visionModels: string[]; textRequired: true; accessRequired: boolean; maxPages: number; }
