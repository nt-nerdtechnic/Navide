# Injected into every CMake project() of the whisper.cpp build through
# CMAKE_PROJECT_INCLUDE_BEFORE (see scripts/build-stt.mjs). ggml defaults to
# GGML_NATIVE=ON, i.e. -march=native / MSVC feature probing of the build host,
# which would ship CI-runner-specific instructions (e.g. AVX-512) to users.
set(GGML_NATIVE OFF CACHE BOOL "Portable release build" FORCE)
