const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const path = require('path');
const fs = require('fs');

async function main() {
  try {
    const token = core.getInput('token', { required: true });
    const username = core.getInput('username');
    const password = core.getInput('password');
    const platforms = core.getInput('platforms', { required: true });
    const tags = core.getInput('tags') || 'latest';

    const client = github.getOctokit(token);

    // Parse JSON event file
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const eventJson = fs.readFileSync(eventPath, { encoding: 'utf-8' });
    const event = JSON.parse(eventJson);

    const dirToImage = new Map();

    // Determine changed dirs and images
    for (const eventCommit of event.commits) {
      const commit = await client.repos.getCommit({
        ...github.context.repo,
        ref: eventCommit.id
      })

      for (const file of commit.data.files) {
        process.chdir(path.dirname(file.filename));

        while (true) {
          const dir = process.cwd();
          const image = path.basename(dir);
          const files = fs.readdirSync(dir);

          if (files.includes('Dockerfile')) {
            dirToImage.set(dir, image);
            break;
          }

          if (dir === process.env.GITHUB_WORKSPACE) {
            break;
          }

          process.chdir('..');
        }
      }
    }

    // Exit early if no images to be built
    if (dirToImage.size === 0) {
      console.log('No images to build!');
      return;
    }

    core.startGroup('==> Print details');
    console.log(dirToImage);
    core.endGroup();

    // Login to registry if desired
    if (username && password) {
      core.startGroup('==> Login to DockerHub');
      await exec.exec(` echo "${password}" | docker login -u ${username} --password-stdin`);
      core.endGroup();
    }

    // Setup buildx
    core.startGroup('==> Prepare buildx');
    await exec.exec('docker', ['run', '--privileged', 'docker/binfmt:66f9012c56a8316f9244ffd7622d7c21c1f6f28d']);
    await exec.exec('docker', ['buildx', 'create', '--use', '--name', 'builder']);
    await exec.exec('docker', ['buildx', 'inspect', '--bootstrap', 'builder']);
    core.endGroup();

    // Build images
    for (const dirAndImage of dirToImage) {
      const dir = dirAndImage[0];
      const image = dirAndImage[1];

      console.log(tags);
      const tagString = tags.split(',').map(tag => `-t ${username ? username : github.context.actor}/${image}:${tag}`).join(' ');
      console.log(tagString);

      core.startGroup(`==> Build '${image}' image`);
      await exec.exec('docker', [
        'buildx',
        'build',
        ... (username && password) ? ['--push'] : [],
        '--platform', platforms,
        tagString,
        dir
      ])
      core.endGroup();
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

main();
