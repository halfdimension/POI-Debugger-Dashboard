import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap } from 'maplibre-gl';
import type { TurnOccurrence } from '../../turnPoiCoverage';
import { TURN_COVERAGE_RADIUS_M } from '../../turnPoiCoverage';

export const TURN_COVERAGE_3D_LAYER_ID = 'turn-poi-coverage-3d';

type Buffers = { vertex: WebGLBuffer; count: number; origin: [number, number, number] };

function translatedMatrix(matrix: ArrayLike<number>, origin: [number, number, number]): Float32Array {
  const result = new Float32Array(matrix);
  const [x, y, z] = origin;
  result[12] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  result[13] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  result[14] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  result[15] = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  return result;
}

export class TurnCoverageCustomLayer implements CustomLayerInterface {
  id = TURN_COVERAGE_3D_LAYER_ID;
  type = 'custom' as const;
  renderingMode = '3d' as const;
  private map: MapLibreMap | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffers: Buffers[] = [];
  private turns: TurnOccurrence[] = [];
  private visible = false;

  setTurns(turns: TurnOccurrence[], visible: boolean): void {
    this.turns = turns;
    this.visible = visible;
    this.rebuild();
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const vertex = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vertex, webgl2
      ? `#version 300 es
in vec4 a_pos; uniform mat4 u_matrix; out float v_height; void main(){v_height=a_pos.w;gl_Position=u_matrix*vec4(a_pos.xyz,1.0);}`
      : `attribute vec4 a_pos; uniform mat4 u_matrix; varying float v_height; void main(){v_height=a_pos.w;gl_Position=u_matrix*vec4(a_pos.xyz,1.0);}`);
    gl.compileShader(vertex);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fragment, webgl2
      ? `#version 300 es
precision mediump float; in float v_height; out vec4 fragColor; void main(){float glow=0.13+clamp(v_height,0.0,1.0)*0.14;fragColor=vec4(0.02,0.62,0.78,glow);}`
      : `precision mediump float; varying float v_height; void main(){float glow=0.13+clamp(v_height,0.0,1.0)*0.14;gl_FragColor=vec4(0.02,0.62,0.78,glow);}`);
    gl.compileShader(fragment);
    this.program = gl.createProgram();
    if (!this.program) return;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    this.rebuild();
  }

  onRemove(): void {
    this.clearBuffers();
    if (this.gl && this.program) this.gl.deleteProgram(this.program);
    this.program = null;
    this.gl = null;
    this.map = null;
  }

  private clearBuffers(): void {
    if (this.gl) for (const item of this.buffers) this.gl.deleteBuffer(item.vertex);
    this.buffers = [];
  }

  private rebuild(): void {
    const gl = this.gl;
    if (!gl) return;
    this.clearBuffers();
    for (const turn of this.turns) {
      if (!turn.incoming) continue;
      const origin = MercatorCoordinate.fromLngLat(turn.origin, 0);
      const scale = origin.meterInMercatorCoordinateUnits();
      const values: number[] = [];
      const radialSegments = 24;
      const arcSegments = 32;
      // Hemisphere x^2+y^2+z^2=r^2, clipped to dot((x,y), D)<=0.
      for (let ring = 0; ring < radialSegments; ring += 1) {
        const r0 = TURN_COVERAGE_RADIUS_M * ring / radialSegments;
        const r1 = TURN_COVERAGE_RADIUS_M * (ring + 1) / radialSegments;
        const z0 = Math.sqrt(Math.max(0, TURN_COVERAGE_RADIUS_M ** 2 - r0 ** 2));
        const z1 = Math.sqrt(Math.max(0, TURN_COVERAGE_RADIUS_M ** 2 - r1 ** 2));
        for (let arc = 0; arc < arcSegments; arc += 1) {
          const a0 = Math.PI / 2 + Math.PI * arc / arcSegments;
          const a1 = Math.PI / 2 + Math.PI * (arc + 1) / arcSegments;
          const point = (radius: number, angle: number, height: number) => {
            const along = radius * Math.cos(angle);
            const lateral = radius * Math.sin(angle);
            const east = turn.incoming!.east * along - turn.incoming!.north * lateral;
            const north = turn.incoming!.north * along + turn.incoming!.east * lateral;
            // Keep the mesh origin-relative. Absolute Mercator coordinates in
            // Float32 vertex buffers lose visible precision at a 30 m scale.
            return [east * scale, -north * scale, height * scale, height / TURN_COVERAGE_RADIUS_M];
          };
          const p00 = point(r0, a0, z0); const p10 = point(r1, a0, z1);
          const p11 = point(r1, a1, z1); const p01 = point(r0, a1, z0);
          values.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
        }
      }
      const buffer = gl.createBuffer();
      if (!buffer) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.STATIC_DRAW);
      this.buffers.push({ vertex: buffer, count: values.length / 4, origin: [origin.x, origin.y, origin.z] });
    }
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, input: CustomRenderMethodInput): void {
    if (!this.visible || !this.program || this.buffers.length === 0) return;
    gl.useProgram(this.program);
    const matrixLocation = gl.getUniformLocation(this.program, 'u_matrix');
    const location = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(location);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    for (const item of this.buffers) {
      const matrix = translatedMatrix(input.defaultProjectionData.mainMatrix, item.origin);
      gl.uniformMatrix4fv(matrixLocation, false, matrix);
      gl.bindBuffer(gl.ARRAY_BUFFER, item.vertex);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, item.count);
    }
    gl.depthMask(true);
  }
}
