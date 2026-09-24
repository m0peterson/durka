import { getDeployStore, getStore } from "@netlify/blobs";

// Настройки и ключи общие для всех деплоев, иначе после каждого деплоя
// админку пришлось бы заполнять заново.
export function configStore() {
  return getStore({ name: "durka-config", consistency: "strong" });
}

// Задания с картинками. В продакшене общий стор (его чистит cleanup),
// в превью и бранч-деплоях стор привязан к деплою и удаляется вместе с ним.
// Локально (netlify dev) стор и так песочница, ID деплоя там нет.
export function jobStore(deploy: { context: string; id: string }) {
  if (deploy.context === "production" || deploy.context === "dev" || !deploy.id) {
    return getStore({ name: "durka-jobs", consistency: "strong" });
  }
  return getDeployStore({ name: "durka-jobs", deployID: deploy.id, consistency: "strong" });
}

export const JOB_ID_RE = /^[a-z0-9]{6,12}-[A-Za-z0-9_-]{16}$/;

export function jobKey(id: string): string {
  return `job/${id}`;
}
