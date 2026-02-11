import type { Project } from '../types/project'
import { deriveProjectLabelFromSource, normalizeProjectLabel } from './project'

export interface LinkableCredential {
  id: string
  provider: string
  source?: string | null
}

export interface ProviderLinkageContext {
  keyCount: number
  projectCount: number
  pathCount: number
  projectNames: string[]
  paths: string[]
}

function normalizePath(input?: string | null): string {
  if (!input) return ''
  return input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').trim().toLowerCase()
}

function projectAliases(project: Project): Set<string> {
  const aliases = new Set<string>()
  const name = project.name.trim().toLowerCase()
  if (name) aliases.add(name)

  const normalizedPath = project.path.replace(/\\/g, '/')
  const parts = normalizedPath.split('/').filter(Boolean)
  const basename = parts[parts.length - 1]?.trim().toLowerCase()
  if (basename) aliases.add(basename)

  return aliases
}

function findProjectByAlias(label: string, projects: Project[]): Project | undefined {
  const target = label.trim().toLowerCase()
  if (!target) return undefined
  return projects.find((project) => projectAliases(project).has(target))
}

function findProjectBySourcePath(source?: string | null, projects: Project[] = []): Project | undefined {
  const sourcePath = normalizePath(source)
  if (!sourcePath) return undefined

  return projects.find((project) => {
    const projectPath = normalizePath(project.path)
    if (!projectPath) return false
    return (
      sourcePath === projectPath ||
      sourcePath.startsWith(`${projectPath}/`) ||
      projectPath.startsWith(`${sourcePath}/`)
    )
  })
}

export function resolveCredentialProjectName(
  credential: LinkableCredential,
  projectLabelsByCredential: Record<string, string>,
  projects: Project[]
): string {
  const manualLabel = normalizeProjectLabel(projectLabelsByCredential[credential.id])
  if (manualLabel) {
    const matchedProject = findProjectByAlias(manualLabel, projects)
    return matchedProject?.name || manualLabel
  }

  const sourceMatched = findProjectBySourcePath(credential.source, projects)
  if (sourceMatched) {
    return sourceMatched.name
  }

  const derived = deriveProjectLabelFromSource(credential.source)
  const aliasMatched = findProjectByAlias(derived, projects)
  return aliasMatched?.name || derived
}

export function getCredentialsLinkedToProject<T extends LinkableCredential>(
  project: Project,
  credentials: T[],
  projectLabelsByCredential: Record<string, string>,
  projects: Project[]
): T[] {
  const aliases = projectAliases(project)
  return credentials.filter((credential) => {
    if (project.credential_id && project.credential_id === credential.id) {
      return true
    }
    const resolved = resolveCredentialProjectName(credential, projectLabelsByCredential, projects)
    return aliases.has(resolved.trim().toLowerCase())
  })
}

export function buildProviderContext(
  providerId: string,
  credentials: LinkableCredential[],
  projectLabelsByCredential: Record<string, string>,
  projects: Project[]
): ProviderLinkageContext {
  const providerCredentials = credentials.filter((credential) => credential.provider === providerId)
  const projectNameSet = new Set<string>()
  const pathSet = new Set<string>()
  const credentialById = new Map(credentials.map((credential) => [credential.id, credential]))
  const projectByName = new Map(projects.map((project) => [project.name.trim().toLowerCase(), project]))

  providerCredentials.forEach((credential) => {
    if (credential.source?.trim()) {
      pathSet.add(credential.source.trim())
    }
    const projectName = resolveCredentialProjectName(credential, projectLabelsByCredential, projects)
    if (projectName && projectName !== '未归类' && projectName !== '当前目录') {
      projectNameSet.add(projectName)
      const matchedProject = projectByName.get(projectName.trim().toLowerCase())
      if (matchedProject?.path?.trim()) {
        pathSet.add(matchedProject.path.trim())
      }
    }
  })

  projects.forEach((project) => {
    if (!project.credential_id) return
    const bound = credentialById.get(project.credential_id)
    if (!bound || bound.provider !== providerId) return
    projectNameSet.add(project.name)
    if (project.path.trim()) {
      pathSet.add(project.path.trim())
    }
  })

  const projectNames = Array.from(projectNameSet).sort((a, b) => a.localeCompare(b))
  const paths = Array.from(pathSet).sort((a, b) => a.localeCompare(b))

  return {
    keyCount: providerCredentials.length,
    projectCount: projectNames.length,
    pathCount: paths.length,
    projectNames,
    paths,
  }
}

export function buildProviderContextMap(
  credentials: LinkableCredential[],
  projectLabelsByCredential: Record<string, string>,
  projects: Project[]
): Record<string, ProviderLinkageContext> {
  const providers = new Set<string>(credentials.map((credential) => credential.provider))
  projects.forEach((project) => {
    if (!project.credential_id) return
    const bound = credentials.find((credential) => credential.id === project.credential_id)
    if (bound?.provider) providers.add(bound.provider)
  })

  const result: Record<string, ProviderLinkageContext> = {}
  providers.forEach((providerId) => {
    result[providerId] = buildProviderContext(
      providerId,
      credentials,
      projectLabelsByCredential,
      projects
    )
  })
  return result
}
