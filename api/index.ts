import express, { Request, Response } from 'express';
import cors from 'cors';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
// @ts-ignore
import sodium from 'tweetsodium';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

interface ProjectFile {
  path: string;
  content: string;
}

interface DeployRequest {
  projectName: string;
  projectSlug: string;
  files: ProjectFile[];
  githubToken: string;
  githubUsername: string;
  expoToken: string;
  expoUsername: string;
}

// ---------- HEALTH ----------
app.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'MUTANT Backend',
    version: '1.0.0',
    endpoints: {
      health: 'GET /',
      deploy: 'POST /api/deploy',
      status: 'GET /api/status/:owner/:repo',
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

// ---------- HELPER: encriptar secret ----------
function encryptSecret(publicKey: string, secretValue: string): string {
  const messageBytes = Buffer.from(secretValue);
  const keyBytes = Buffer.from(publicKey, 'base64');
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  return Buffer.from(encryptedBytes).toString('base64');
}

// ---------- HELPER: enriquece el proyecto con OTA ----------
function augmentProjectForOTA(files: ProjectFile[], slug: string): ProjectFile[] {
  const augmented = [...files];

  // Buscar y actualizar app.json / app.config
  const appJsonIdx = augmented.findIndex((f) => f.path === 'app.json');
  const appConfigIdx = augmented.findIndex(
    (f) => f.path === 'app.config.js' || f.path === 'app.config.ts'
  );

  if (appJsonIdx !== -1) {
    try {
      const config = JSON.parse(augmented[appJsonIdx].content);
      if (!config.expo) config.expo = {};

      config.expo.slug = slug;
      config.expo.runtimeVersion = { policy: 'appVersion' };
      config.expo.updates = {
        enabled: true,
        checkAutomatically: 'ON_LOAD',
        fallbackToCacheTimeout: 0,
      };

      // Habilitar plugin de expo-updates
      if (!config.expo.plugins) config.expo.plugins = [];
      if (!config.expo.plugins.includes('expo-updates')) {
        config.expo.plugins.push('expo-updates');
      }

      augmented[appJsonIdx].content = JSON.stringify(config, null, 2);
    } catch (e) {
      console.warn('No se pudo parsear app.json:', e);
    }
  }

  // Asegurarse que package.json tenga expo-updates
  const pkgIdx = augmented.findIndex((f) => f.path === 'package.json');
  if (pkgIdx !== -1) {
    try {
      const pkg = JSON.parse(augmented[pkgIdx].content);
      if (!pkg.dependencies) pkg.dependencies = {};
      if (!pkg.dependencies['expo-updates']) {
        pkg.dependencies['expo-updates'] = '~29.0.13';
      }
      augmented[pkgIdx].content = JSON.stringify(pkg, null, 2);
    } catch {}
  }

  return augmented;
}

// ---------- HELPER: crea workflow de GitHub Actions ----------
function getWorkflowContent(): string {
  return `name: EAS Build APK

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: 🏗 Checkout
        uses: actions/checkout@v4

      - name: 🏗 Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: 🏗 Setup EAS
        uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: \${{ secrets.EXPO_TOKEN }}

      - name: 📦 Install dependencies
        run: npm install --legacy-peer-deps

      - name: 🚀 Build APK on EAS
        run: eas build --platform android --profile preview --non-interactive --no-wait

      - name: ✅ Done
        run: echo "Build enviado a EAS. Ver progreso en https://expo.dev"
`;
}

function getEasJson(): string {
  return JSON.stringify(
    {
      cli: { version: '>= 5.0.0', appVersionSource: 'local' },
      build: {
        preview: {
          distribution: 'internal',
          channel: 'preview',
          android: { buildType: 'apk' },
        },
        production: {
          channel: 'production',
        },
      },
      submit: { production: {} },
    },
    null,
    2
  );
}

// ---------- MAIN ENDPOINT: DEPLOY ----------
app.post('/api/deploy', async (req: Request, res: Response) => {
  const {
    projectName,
    projectSlug,
    files,
    githubToken,
    githubUsername,
    expoToken,
    expoUsername,
  } = req.body as DeployRequest;

  // Validaciones
  const missing: string[] = [];
  if (!projectSlug) missing.push('projectSlug');
  if (!files || !Array.isArray(files) || files.length === 0) missing.push('files');
  if (!githubToken) missing.push('githubToken');
  if (!githubUsername) missing.push('githubUsername');
  if (!expoToken) missing.push('expoToken');
  if (!expoUsername) missing.push('expoUsername');

  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Faltan campos requeridos',
      missing,
    });
  }

  const logs: string[] = [];
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logs.push(line);
  };

  try {
    log(`🧬 MUTANT Deploy iniciado: ${projectName}`);
    log(`👤 GitHub: ${githubUsername}`);
    log(`👤 Expo: ${expoUsername}`);

    const octokit = new Octokit({ auth: githubToken });
    const repoName = `mutant-${projectSlug}`.substring(0, 90).toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // ---- 1. Crear repo ----
    let repoUrl = '';
    let repoExists = false;

    try {
      log(`📦 Creando repositorio: ${repoName}`);
      const { data: repo } = await octokit.repos.createForAuthenticatedUser({
        name: repoName,
        description: `MUTANT v1 → ${projectName}`,
        private: false,
        auto_init: true,
      });
      repoUrl = repo.html_url;
      log(`✅ Repo creado: ${repoUrl}`);
      // Esperamos un momento a que GitHub inicialice el repo
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e: any) {
      if (e.status === 422) {
        log(`ℹ️ Repo ya existe, se actualizará`);
        repoExists = true;
        repoUrl = `https://github.com/${githubUsername}/${repoName}`;
      } else {
        throw new Error(`Error creando repo: ${e.message}`);
      }
    }

    // ---- 2. Configurar secret EXPO_TOKEN ----
    log(`🔑 Configurando secret EXPO_TOKEN...`);
    try {
      const { data: publicKey } = await octokit.actions.getRepoPublicKey({
        owner: githubUsername,
        repo: repoName,
      });

      const encrypted = encryptSecret(publicKey.key, expoToken);

      await octokit.actions.createOrUpdateRepoSecret({
        owner: githubUsername,
        repo: repoName,
        secret_name: 'EXPO_TOKEN',
        encrypted_value: encrypted,
        key_id: publicKey.key_id,
      });

      log(`✅ Secret EXPO_TOKEN configurado`);
    } catch (e: any) {
      log(`⚠️ Error configurando secret: ${e.message}`);
      log(`ℹ️ Puedes agregarlo manualmente en: ${repoUrl}/settings/secrets/actions`);
    }

    // ---- 3. Preparar todos los archivos con OTA ----
    const augmentedFiles = augmentProjectForOTA(files, projectSlug);

    const allFiles: ProjectFile[] = [
      ...augmentedFiles,
      { path: '.github/workflows/build.yml', content: getWorkflowContent() },
      { path: 'eas.json', content: getEasJson() },
      {
        path: 'README.md',
        content: `# ${projectName}

Generado por **MUTANT v1** 🧬

## Build en progreso
1. Ve a la pestaña [Actions](${repoUrl}/actions) de este repo
2. Espera a que termine (~10-15 min)
3. El APK estará en tu [dashboard de Expo](https://expo.dev/accounts/${expoUsername}/projects)

## Actualizaciones OTA
Este proyecto tiene \`expo-updates\` habilitado.  
Cualquier cambio se puede desplegar sin recompilar usando:
\`\`\`bash
eas update --branch production --message "Update"
\`\`\`
`,
      },
      {
        path: '.gitignore',
        content: `node_modules/
.expo/
dist/
web-build/
*.log
.env
.env.local
.DS_Store
android/
ios/
*.orig.*`,
      },
    ];

    // ---- 4. Subir archivos ----
    log(`📤 Subiendo ${allFiles.length} archivos...`);

    let uploaded = 0;
    let errors = 0;

    for (const file of allFiles) {
      try {
        const contentBase64 = Buffer.from(file.content).toString('base64');

        // Ver si el archivo ya existe
        let sha: string | undefined;
        try {
          const { data: existing } = await octokit.repos.getContent({
            owner: githubUsername,
            repo: repoName,
            path: file.path,
          });
          if ('sha' in existing) sha = existing.sha;
        } catch {
          // No existe, se creará nuevo
        }

        await octokit.repos.createOrUpdateFileContents({
          owner: githubUsername,
          repo: repoName,
          path: file.path,
          message: `MUTANT: ${sha ? 'update' : 'create'} ${file.path}`,
          content: contentBase64,
          sha,
        });

        uploaded++;
      } catch (e: any) {
        errors++;
        log(`⚠️ Error en ${file.path}: ${e.message}`);
      }
    }

    log(`✅ Subidos: ${uploaded}/${allFiles.length} (errores: ${errors})`);

    // ---- 5. Disparar workflow manualmente por si el push no lo activa ----
    try {
      await new Promise((r) => setTimeout(r, 2000));
      await octokit.actions.createWorkflowDispatch({
        owner: githubUsername,
        repo: repoName,
        workflow_id: 'build.yml',
        ref: 'main',
      });
      log(`🚀 Workflow disparado manualmente`);
    } catch (e: any) {
      log(`ℹ️ Workflow se activará con el push (${e.message})`);
    }

    // ---- 6. Response ----
    return res.json({
      success: true,
      projectName,
      projectSlug,
      repoName,
      repoUrl,
      actionsUrl: `${repoUrl}/actions`,
      expoDashboard: `https://expo.dev/accounts/${expoUsername}/projects`,
      stats: {
        filesUploaded: uploaded,
        filesTotal: allFiles.length,
        errors,
      },
      nextSteps: [
        `1. Espera 10-15 min mientras GitHub Actions compila`,
        `2. Ve al dashboard de Expo para descargar el APK`,
        `3. Instálalo en tu celular`,
        `4. Cualquier cambio futuro será por OTA (segundos, no minutos)`,
      ],
      logs,
    });
  } catch (error: any) {
    log(`❌ ERROR: ${error.message}`);
    return res.status(500).json({
      error: error.message,
      logs,
    });
  }
});

// ---------- STATUS ENDPOINT ----------
app.get('/api/status/:owner/:repo', async (req: Request, res: Response) => {
  const owner = String(req.params.owner);
  const repo = String(req.params.repo);
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Token requerido en Authorization header' });
  }

  try {
    const octokit = new Octokit({ auth: token });
    const { data: runs } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 5,
    });

    return res.json({
      repo: `${owner}/${repo}`,
      runs: runs.workflow_runs.map((r) => ({
        id: r.id,
        status: r.status,
        conclusion: r.conclusion,
        createdAt: r.created_at,
        htmlUrl: r.html_url,
      })),
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------- LOCAL ----------
const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`\n🧬 MUTANT Backend v1.0.0`);
    console.log(`🌐 http://localhost:${port}`);
    console.log(`\nEndpoints:`);
    console.log(`  GET  /`);
    console.log(`  POST /api/deploy`);
    console.log(`  GET  /api/status/:owner/:repo\n`);
  });
}

export default app;