# Contributing to dsh-clawbot

Thank you for your interest in contributing! This document explains how to set up, develop, and submit changes.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```sh
   git clone https://github.com/<your-username>/dsh-clawbot.git
   cd dsh-clawbot
   ```
3. **Install dependencies**:
   ```sh
   pnpm install
   ```
4. **Run tests** to make sure everything works:
   ```sh
   pnpm test
   ```

## Development Workflow

1. Create a feature branch from `main`:
   ```sh
   git checkout -b feat/your-feature-name
   ```
2. Make your changes
3. Add or update tests in `test/`
4. Run tests:
   ```sh
   pnpm test
   ```
5. Commit with a clear message:
   ```sh
   git commit -m "feat: add your feature"
   ```

## Code Style

- Use ES modules (`import` / `export`)
- Follow the existing code style in the project
- Add comments for non-obvious logic, especially protocol details and concurrency controls
- Keep functions small and focused

## Testing

- All tests use `node:test` — no external test framework needed
- Test files live in `test/*.test.mjs`
- Write tests for new features and bug fixes
- Run the full suite before submitting:
  ```sh
  node --test test/*.test.mjs
  ```

## Submitting a Pull Request

1. Push your branch to your fork
2. Open a PR against `main` in the upstream repository
3. Fill in the PR template — describe **what** changed and **why**
4. Link any related issues
5. Wait for review; address feedback if requested

## Reporting Issues

- Use the **Bug Report** template for bugs
- Use the **Feature Request** template for new ideas
- Include your Node.js version, dsh version, and OS
- Attach logs from `/weixin/logs` if relevant

## Areas That Need Help

- Group chat support (currently single-chat only)
- File / video message support
- Authentication for the `/weixin` panel
- More tests for edge cases
- Documentation improvements

## Questions?

Open an issue with the **Question** template, or start a discussion in GitHub Discussions.

Thank you for helping make dsh-clawbot better!
