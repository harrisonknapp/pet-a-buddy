(function () {
  "use strict";

  const pets = [
    { name: "MORP", src: "./assets/morp.png" },
    { name: "NOONIE", src: "./assets/noonie.png" },
    { name: "MOUSE", src: "./assets/mouse.png" },
  ];

  const canvas = document.querySelector("#petCanvas");
  const viewport = document.querySelector("#petViewport");
  const fallbackPet = document.querySelector("#fallbackPet");
  const petTitle = document.querySelector("#petTitle");
  const petHint = document.querySelector("#petHint");
  const petAnnouncement = document.querySelector("#petAnnouncement");
  const pettingHand = document.querySelector("#pettingHand");
  const previousButton = document.querySelector("#previousPet");
  const nextButton = document.querySelector("#nextPet");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const loadedPets = pets.map((pet) => {
    const image = new Image();
    image.decoding = "async";
    image.src = pet.src;
    return { ...pet, image };
  });

  const alphaCanvas = document.createElement("canvas");
  const alphaContext = alphaCanvas.getContext("2d", { willReadFrequently: true });
  let alphaPixels = null;
  let currentImage = null;
  let currentIndex = 0;
  let selectionToken = 0;
  let activePointerId = null;
  let lastPointer = null;
  let renderer = null;

  class PetRenderer {
    constructor(targetCanvas) {
      this.canvas = targetCanvas;
      this.gl = targetCanvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        depth: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
      });

      if (!this.gl) {
        throw new Error("WebGL is unavailable");
      }

      this.pointer = [0.5, 0.5];
      this.velocity = [0, 0];
      this.targetStrength = 0;
      this.strength = 0;
      this.imageSize = [1, 1];
      this.running = false;
      this.frame = this.frame.bind(this);
      this.createScene();
    }

    createShader(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);

      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(message || "Unable to compile WebGL shader");
      }

      return shader;
    }

    createScene() {
      const gl = this.gl;
      const vertexShader = this.createShader(
        gl.VERTEX_SHADER,
        `
          attribute vec2 a_position;
          varying vec2 v_uv;

          void main() {
            v_uv = a_position * 0.5 + 0.5;
            gl_Position = vec4(a_position, 0.0, 1.0);
          }
        `,
      );
      const fragmentShader = this.createShader(
        gl.FRAGMENT_SHADER,
        `
          precision mediump float;

          uniform sampler2D u_texture;
          uniform vec2 u_resolution;
          uniform vec2 u_imageSize;
          uniform vec2 u_pointer;
          uniform vec2 u_velocity;
          uniform float u_strength;
          uniform float u_radius;
          varying vec2 v_uv;

          vec2 containTextureUv(vec2 canvasUv) {
            float canvasAspect = u_resolution.x / u_resolution.y;
            float imageAspect = u_imageSize.x / u_imageSize.y;
            vec2 textureUv = canvasUv;

            if (canvasAspect > imageAspect) {
              float displayedWidth = imageAspect / canvasAspect;
              textureUv.x = (canvasUv.x - 0.5) / displayedWidth + 0.5;
            } else {
              float displayedHeight = canvasAspect / imageAspect;
              textureUv.y = (canvasUv.y - 0.5) / displayedHeight + 0.5;
            }

            return textureUv;
          }

          void main() {
            vec2 deltaUv = v_uv - u_pointer;
            vec2 deltaPx = deltaUv * u_resolution;
            float distancePx = length(deltaPx);
            float influence = smoothstep(u_radius, 0.0, distancePx) * u_strength;
            float lensStrength = 0.72 * influence * influence;
            vec2 magnifyOffset = -deltaUv * lensStrength;
            vec2 dragOffset = -u_velocity * influence * 0.35;
            vec2 sampleUv = v_uv + magnifyOffset + dragOffset;
            vec2 textureUv = containTextureUv(sampleUv);

            if (
              textureUv.x < 0.0 || textureUv.x > 1.0 ||
              textureUv.y < 0.0 || textureUv.y > 1.0
            ) {
              gl_FragColor = vec4(0.0);
            } else {
              gl_FragColor = texture2D(u_texture, textureUv);
            }
          }
        `,
      );

      this.program = gl.createProgram();
      gl.attachShader(this.program, vertexShader);
      gl.attachShader(this.program, fragmentShader);
      gl.linkProgram(this.program);

      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(this.program) || "Unable to link WebGL program");
      }

      gl.useProgram(this.program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      const positions = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positions);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );

      const positionLocation = gl.getAttribLocation(this.program, "a_position");
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      this.uniforms = {
        resolution: gl.getUniformLocation(this.program, "u_resolution"),
        imageSize: gl.getUniformLocation(this.program, "u_imageSize"),
        pointer: gl.getUniformLocation(this.program, "u_pointer"),
        velocity: gl.getUniformLocation(this.program, "u_velocity"),
        strength: gl.getUniformLocation(this.program, "u_strength"),
        radius: gl.getUniformLocation(this.program, "u_radius"),
      };

      this.texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.clearColor(0, 0, 0, 0);
      gl.disable(gl.DEPTH_TEST);
    }

    setImage(image) {
      const gl = this.gl;
      this.imageSize = [image.naturalWidth, image.naturalHeight];
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      this.wake();
    }

    setPointer(x, y, velocityX, velocityY) {
      this.pointer[0] = x;
      this.pointer[1] = y;
      this.velocity[0] = Math.max(-0.085, Math.min(0.085, velocityX));
      this.velocity[1] = Math.max(-0.085, Math.min(0.085, velocityY));
      this.wake();
    }

    setStrength(strength) {
      this.targetStrength = reducedMotion ? strength * 0.45 : strength;
      this.wake();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * pixelRatio));
      const height = Math.max(1, Math.round(rect.height * pixelRatio));

      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.gl.viewport(0, 0, width, height);
      }
    }

    draw() {
      const gl = this.gl;
      this.resize();
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
      gl.uniform2f(this.uniforms.imageSize, this.imageSize[0], this.imageSize[1]);
      gl.uniform2f(this.uniforms.pointer, this.pointer[0], this.pointer[1]);
      gl.uniform2f(this.uniforms.velocity, this.velocity[0], this.velocity[1]);
      gl.uniform1f(this.uniforms.strength, this.strength);
      gl.uniform1f(
        this.uniforms.radius,
        Math.max(90, Math.min(220, Math.min(this.canvas.width, this.canvas.height) * 0.32)),
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    frame(time) {
      this.strength += (this.targetStrength - this.strength) * 0.16;
      this.velocity[0] *= 0.9;
      this.velocity[1] *= 0.9;
      this.draw();

      const isMoving = Math.abs(this.velocity[0]) + Math.abs(this.velocity[1]) > 0.0001;
      if (this.targetStrength > 0 || this.strength > 0.002 || isMoving) {
        window.requestAnimationFrame(this.frame);
      } else {
        this.strength = 0;
        this.running = false;
      }
    }

    wake() {
      if (this.running) return;
      this.running = true;
      window.requestAnimationFrame(this.frame);
    }
  }

  function prepareAlphaMap(image) {
    if (!alphaContext) return;
    alphaCanvas.width = image.naturalWidth;
    alphaCanvas.height = image.naturalHeight;
    alphaContext.clearRect(0, 0, alphaCanvas.width, alphaCanvas.height);
    alphaContext.drawImage(image, 0, 0);

    try {
      alphaPixels = alphaContext.getImageData(0, 0, alphaCanvas.width, alphaCanvas.height).data;
    } catch (_error) {
      alphaPixels = null;
    }
  }

  function pointerToPet(clientX, clientY) {
    if (!currentImage) return null;
    const rect = viewport.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const canvasAspect = rect.width / rect.height;
    const imageAspect = currentImage.naturalWidth / currentImage.naturalHeight;
    let textureX;
    let textureY;

    if (canvasAspect > imageAspect) {
      const displayedWidth = rect.height * imageAspect;
      const offsetX = (rect.width - displayedWidth) * 0.5;
      textureX = (localX - offsetX) / displayedWidth;
      textureY = localY / rect.height;
    } else {
      const displayedHeight = rect.width / imageAspect;
      const offsetY = (rect.height - displayedHeight) * 0.5;
      textureX = localX / rect.width;
      textureY = (localY - offsetY) / displayedHeight;
    }

    return { rect, localX, localY, textureX, textureY };
  }

  function isOnPet(clientX, clientY) {
    const position = pointerToPet(clientX, clientY);
    if (!position) return false;
    const { textureX, textureY } = position;

    if (textureX < 0 || textureX > 1 || textureY < 0 || textureY > 1) {
      return false;
    }

    if (!alphaPixels) return true;
    const pixelX = Math.min(alphaCanvas.width - 1, Math.floor(textureX * alphaCanvas.width));
    const pixelY = Math.min(alphaCanvas.height - 1, Math.floor(textureY * alphaCanvas.height));
    const alphaIndex = (pixelY * alphaCanvas.width + pixelX) * 4 + 3;
    return alphaPixels[alphaIndex] > 20;
  }

  function updateInteraction(event, strength) {
    const rect = viewport.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const yFromTop = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const y = 1 - yFromTop;
    const velocityX = lastPointer ? x - lastPointer.x : 0;
    const velocityY = lastPointer ? y - lastPointer.y : 0;
    lastPointer = { x, y };

    pettingHand.style.setProperty("--hand-x", `${x * 100}%`);
    pettingHand.style.setProperty("--hand-y", `${yFromTop * 100}%`);
    viewport.style.setProperty("--fallback-x", `${x * 100}%`);
    viewport.style.setProperty("--fallback-y", `${yFromTop * 100}%`);
    pettingHand.classList.add("is-visible");
    viewport.classList.add("is-petting");
    petHint.classList.add("is-hidden");

    if (renderer) {
      renderer.setPointer(x, y, velocityX, velocityY);
      renderer.setStrength(strength);
    }
  }

  function stopInteraction() {
    lastPointer = null;
    pettingHand.classList.remove("is-visible");
    viewport.classList.remove("is-petting", "is-pressed");
    if (renderer) renderer.setStrength(0);
  }

  async function selectPet(nextIndex, shouldAnnounce = true) {
    currentIndex = (nextIndex + loadedPets.length) % loadedPets.length;
    const token = ++selectionToken;
    const pet = loadedPets[currentIndex];

    stopInteraction();
    activePointerId = null;
    currentImage = null;
    alphaPixels = null;
    petTitle.textContent = `PET A ${pet.name}`;
    canvas.setAttribute("aria-label", `${pet.name}, ready to be petted`);
    fallbackPet.src = pet.src;
    viewport.classList.add("is-changing");

    try {
      if (!pet.image.complete || pet.image.naturalWidth === 0) {
        await pet.image.decode();
      }
    } catch (_error) {
      await new Promise((resolve) => {
        pet.image.addEventListener("load", resolve, { once: true });
        pet.image.addEventListener("error", resolve, { once: true });
      });
    }

    if (token !== selectionToken || pet.image.naturalWidth === 0) return;
    currentImage = pet.image;
    prepareAlphaMap(pet.image);
    if (renderer) renderer.setImage(pet.image);
    viewport.classList.remove("is-changing");

    if (shouldAnnounce) {
      petAnnouncement.textContent = `${pet.name} selected.`;
    }
  }

  previousButton.addEventListener("click", () => selectPet(currentIndex - 1));
  nextButton.addEventListener("click", () => selectPet(currentIndex + 1));

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") selectPet(currentIndex - 1);
    if (event.key === "ArrowRight") selectPet(currentIndex + 1);
  });

  viewport.addEventListener("pointerdown", (event) => {
    if (activePointerId !== null || !isOnPet(event.clientX, event.clientY)) return;
    activePointerId = event.pointerId;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-pressed");
    updateInteraction(event, 1);
    event.preventDefault();
  });

  viewport.addEventListener("pointermove", (event) => {
    if (activePointerId === event.pointerId) {
      updateInteraction(event, 1);
      event.preventDefault();
      return;
    }

    if (event.pointerType === "mouse") {
      if (isOnPet(event.clientX, event.clientY)) {
        updateInteraction(event, 0.8);
      } else {
        stopInteraction();
      }
    }
  });

  function finishPointer(event) {
    if (activePointerId !== event.pointerId) return;
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    activePointerId = null;
    stopInteraction();
  }

  viewport.addEventListener("pointerup", finishPointer);
  viewport.addEventListener("pointercancel", finishPointer);
  viewport.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && activePointerId === null) stopInteraction();
  });

  try {
    renderer = new PetRenderer(canvas);
  } catch (_error) {
    document.body.classList.add("webgl-fallback");
  }

  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver(() => {
      if (renderer) renderer.wake();
    });
    resizeObserver.observe(viewport);
  } else {
    window.addEventListener("resize", () => {
      if (renderer) renderer.wake();
    });
  }

  selectPet(0, false);
})();
