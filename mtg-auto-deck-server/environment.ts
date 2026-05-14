import { config as loadDotenv } from "dotenv"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SERVER_SOURCE_DIRECTORY_NAME = "mtg-auto-deck-server"
const SERVER_BUILD_DIRECTORY_NAME = "dist-server"
const ENV_FILE_NAME = ".env"

loadDotenv({
  path: getServerEnvironmentFilePath(),
})

function getServerEnvironmentFilePath() {
  const currentDirectory = dirname(fileURLToPath(import.meta.url))

  if (basename(currentDirectory) === SERVER_BUILD_DIRECTORY_NAME) {
    return join(
      currentDirectory,
      "..",
      SERVER_SOURCE_DIRECTORY_NAME,
      ENV_FILE_NAME
    )
  }

  return join(currentDirectory, ENV_FILE_NAME)
}
