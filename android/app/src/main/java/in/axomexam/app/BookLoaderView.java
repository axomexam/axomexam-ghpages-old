package in.axomexam.app;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.provider.Settings;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.LinearInterpolator;

import androidx.core.content.ContextCompat;

import java.util.Arrays;

/**
 * A small open book whose five pages flip from right to left, one after another,
 * in a loop: a gradient cover frames a block of cream pages, a ribbon marks the
 * spine, and each page carries ruled lines. The view drives its own loop — it
 * starts when visible and stops when hidden or detached — so callers only toggle
 * visibility.
 */
public class BookLoaderView extends View {

  private static final long CYCLE_MS = 2200L;
  private static final int SHEETS = 5;

  /* Each page takes this share of the cycle to turn; the remainder is the
     stagger between pages. FLIP + (SHEETS - 1) * STAGGER == 1, so the last page
     lands exactly as the cycle restarts and the loop is seamless. */
  private static final float FLIP = 0.46f;
  private static final float STAGGER = (1f - FLIP) / (SHEETS - 1);

  private static final float BOOK_W_DP = 64f; // full spread
  private static final float BOOK_H_DP = 46f;
  private static final float CORNER_DP = 5f;
  private static final float COVER_DP = 5f; // cover frame around the pages
  private static final float FLOAT_DP = 3f;

  private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final RectF rect = new RectF();
  private final Path path = new Path();
  private final float[] angles = new float[SHEETS];
  private final Integer[] order = new Integer[SHEETS];

  private final float density;
  private final int brand;
  private final int brandEnd;
  private final int card;
  private final int inkSoft;
  private final int paper;
  private final int paperShade;
  private final int ribbon;

  private float progress;
  private ValueAnimator animator;

  public BookLoaderView(Context context) {
    this(context, null);
  }

  public BookLoaderView(Context context, AttributeSet attrs) {
    this(context, attrs, 0);
  }

  public BookLoaderView(Context context, AttributeSet attrs, int defStyleAttr) {
    super(context, attrs, defStyleAttr);
    density = getResources().getDisplayMetrics().density;
    brand = ContextCompat.getColor(context, R.color.brand);
    brandEnd = ContextCompat.getColor(context, R.color.brand_end);
    card = ContextCompat.getColor(context, R.color.card);
    inkSoft = ContextCompat.getColor(context, R.color.ink_soft);
    // A faint brand tint on the paper keeps it warm and on-palette.
    paper = mix(card, brand, 0.10f);
    paperShade = mix(card, brand, 0.26f);
    ribbon = mix(brandEnd, inkSoft, 0.25f);
  }

  /* ============================ lifecycle ============================ */

  @Override
  protected void onVisibilityChanged(View changed, int visibility) {
    super.onVisibilityChanged(changed, visibility);
    if (visibility == VISIBLE) {
      if (isAttachedToWindow()) start();
    } else {
      stop();
    }
  }

  @Override
  protected void onAttachedToWindow() {
    super.onAttachedToWindow();
    if (getVisibility() == VISIBLE) start();
  }

  @Override
  protected void onDetachedFromWindow() {
    super.onDetachedFromWindow();
    stop();
  }

  /** Begins the loop; a no-op while already running. */
  public void start() {
    if (animator != null) return;
    if (animationsDisabled()) {
      progress = 0.25f; // a page caught mid-turn
      invalidate();
      return;
    }
    animator = ValueAnimator.ofFloat(0f, 1f);
    animator.setDuration(CYCLE_MS);
    animator.setRepeatCount(ValueAnimator.INFINITE);
    animator.setInterpolator(new LinearInterpolator());
    animator.addUpdateListener(a -> {
      progress = (float) a.getAnimatedValue();
      invalidate();
    });
    animator.start();
  }

  /** Stops the loop and releases the animator. */
  public void stop() {
    if (animator != null) {
      animator.cancel();
      animator = null;
    }
  }

  private boolean animationsDisabled() {
    try {
      return Settings.Global.getFloat(getContext().getContentResolver(),
          Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f;
    } catch (Exception e) {
      return false;
    }
  }

  /* ============================ drawing ============================ */

  @Override
  protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);

    float w = BOOK_W_DP * density;
    float half = w / 2f;
    float h = BOOK_H_DP * density;
    float cx = getWidth() / 2f;
    float top = (getHeight() - h) / 2f;
    float bottom = top + h;
    float left = cx - half;
    float right = cx + half;
    float radius = CORNER_DP * density;

    float floatY = -FLOAT_DP * density * (float) Math.sin(Math.PI * progress);
    canvas.save();
    canvas.translate(0f, floatY);

    drawBookShadow(canvas, left, top, right, bottom, radius);
    drawCover(canvas, left, top, right, bottom, radius);
    drawPageBlock(canvas, cx, top, bottom, right, radius);
    drawRibbon(canvas, cx, top, bottom);

    // Angle per page, then draw bottom-up: the page nearest edge-on is highest,
    // so it must land on top of the rest.
    for (int i = 0; i < SHEETS; i++) {
      angles[i] = -180f * ease(clamp01((progress - i * STAGGER) / FLIP));
      order[i] = i;
    }
    Arrays.sort(order, (a, b) ->
        Float.compare(Math.abs(angles[b] + 90f), Math.abs(angles[a] + 90f)));

    for (int idx : order) {
      drawSheet(canvas, angles[idx], cx, top, bottom, right, radius);
    }

    canvas.restore();
  }

  private void drawBookShadow(Canvas canvas, float left, float top, float right,
                              float bottom, float radius) {
    float lift = 4f * density;
    paint.setStyle(Paint.Style.FILL);
    paint.setShader(null);
    paint.setColor(withAlpha(inkSoft, 0.20f));
    rect.set(left, top + lift, right, bottom + lift);
    canvas.drawRoundRect(rect, radius, radius, paint);
  }

  /** The gradient cover, framing the pages, with a gloss across the top. */
  private void drawCover(Canvas canvas, float left, float top, float right,
                         float bottom, float radius) {
    paint.setStyle(Paint.Style.FILL);
    paint.setShader(new LinearGradient(left, top, right, bottom, brand, brandEnd,
        Shader.TileMode.CLAMP));
    rect.set(left, top, right, bottom);
    canvas.drawRoundRect(rect, radius, radius, paint);

    paint.setShader(new LinearGradient(0f, top, 0f, top + (bottom - top) * 0.5f,
        withAlpha(card, 0.16f), withAlpha(card, 0f), Shader.TileMode.CLAMP));
    canvas.drawRoundRect(rect, radius, radius, paint);
    paint.setShader(null);
  }

  /** The stacked pages inside the cover: cream paper, ruled lines, edge ticks. */
  private void drawPageBlock(Canvas canvas, float cx, float top, float bottom,
                             float right, float radius) {
    float frame = COVER_DP * density;
    float l = cx - (right - cx) + frame;
    float t = top + frame;
    float r = right - frame;
    float b = bottom - frame;

    // Offset edges so the block reads as several sheets.
    paint.setStyle(Paint.Style.FILL);
    paint.setShader(null);
    for (int k = 2; k >= 1; k--) {
      float off = k * 1.1f * density;
      paint.setColor(withAlpha(paperShade, 0.6f));
      rect.set(l + off, t + off, r + off, b + off);
      canvas.drawRoundRect(rect, radius, radius, paint);
    }

    paint.setColor(paper);
    rect.set(l, t, r, b);
    canvas.drawRoundRect(rect, radius, radius, paint);

    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(density);
    paint.setColor(withAlpha(paperShade, 0.85f));
    rect.inset(density / 2f, density / 2f);
    canvas.drawRoundRect(rect, radius, radius, paint);
    rect.inset(-density / 2f, -density / 2f);

    paint.setColor(withAlpha(brand, 0.22f));
    float pad = 7f * density;
    float gap = 9f * density;
    for (float y = t + gap; y < b - gap * 0.4f; y += gap) {
      canvas.drawLine(l + pad, y, r - pad, y, paint);
    }

    paint.setColor(withAlpha(brand, 0.34f));
    float tickTop = t + 5f * density;
    float tickBottom = b - 5f * density;
    for (int k = 1; k <= 3; k++) {
      float d = k * 1.5f * density;
      canvas.drawLine(l + d, tickTop, l + d, tickBottom, paint);
      canvas.drawLine(r - d, tickTop, r - d, tickBottom, paint);
    }

    // Spine: a soft shade down the middle.
    paint.setStyle(Paint.Style.FILL);
    float sw = 3f * density;
    paint.setShader(new LinearGradient(cx - sw, 0f, cx + sw, 0f,
        withAlpha(inkSoft, 0f), withAlpha(inkSoft, 0.24f), Shader.TileMode.CLAMP));
    canvas.drawRect(cx - sw, t, cx, b, paint);
    paint.setShader(new LinearGradient(cx, 0f, cx + sw, 0f,
        withAlpha(inkSoft, 0.24f), withAlpha(inkSoft, 0f), Shader.TileMode.CLAMP));
    canvas.drawRect(cx, t, cx + sw, b, paint);
    paint.setShader(null);
  }

  /** A ribbon bookmark hanging over the spine, above the page block. */
  private void drawRibbon(Canvas canvas, float cx, float top, float bottom) {
    float w = 3f * density;
    float h = 11f * density;
    float y = top + 3f * density;

    paint.setStyle(Paint.Style.FILL);
    paint.setShader(null);
    paint.setColor(withAlpha(inkSoft, 0.16f));
    rect.set(cx - w / 2f + density, y + density, cx + w / 2f + density, y + h);
    canvas.drawRect(rect, paint);

    paint.setColor(ribbon);
    rect.set(cx - w / 2f, y, cx + w / 2f, y + h);
    canvas.drawRect(rect, paint);

    // Notched tail.
    float notch = 2f * density;
    path.reset();
    path.moveTo(cx - w / 2f, y + h);
    path.lineTo(cx, y + h - notch);
    path.lineTo(cx + w / 2f, y + h);
    path.close();
    paint.setColor(ribbon);
    canvas.drawPath(path, paint);
  }

  /**
   * Draws one turning page. It lies on the right at angle 0 and on the left at
   * -180, hinged at the spine; the horizontal scale is {@code cos(angle)}, which
   * mirrors it onto the left half past edge-on. A gradient across the page
   * deepens as it turns, so the flip reads as a lifted sheet.
   */
  private void drawSheet(Canvas canvas, float angle, float cx, float top, float bottom,
                         float right, float radius) {
    float radians = (float) Math.toRadians(angle);
    float scaleX = (float) Math.cos(radians);
    if (Math.abs(scaleX) < 0.02f) return; // edge-on: nothing to see

    float edgeOn = Math.abs((float) Math.sin(radians)); // 0 flat, 1 edge-on

    canvas.save();
    canvas.translate(cx, 0f);
    canvas.scale(scaleX, 1f);
    canvas.translate(-cx, 0f);

    float frame = COVER_DP * density;
    float l = cx;
    float t = top + frame;
    float r = right - frame;
    float b = bottom - frame;

    // Shadow just past the hinge, so the lifted page reads as raised.
    if (edgeOn > 0.12f) {
      float lift = 2f * density * edgeOn;
      paint.setStyle(Paint.Style.FILL);
      paint.setShader(null);
      paint.setColor(withAlpha(inkSoft, 0.16f * edgeOn));
      rect.set(l + lift, t + lift, r + lift, b + lift);
      canvas.drawRoundRect(rect, radius, radius, paint);
    }

    paint.setStyle(Paint.Style.FILL);
    paint.setColor(paper);
    rect.set(l, t, r, b);
    canvas.drawRoundRect(rect, radius, radius, paint);

    // Gradient across the page: bright near the spine, deepening outward, and
    // the whole sheet dims as it turns edge-on.
    paint.setShader(new LinearGradient(l, 0f, r, 0f,
        withAlpha(brand, 0.06f + 0.12f * edgeOn),
        withAlpha(inkSoft, 0.20f * edgeOn), Shader.TileMode.CLAMP));
    canvas.drawRoundRect(rect, radius, radius, paint);
    paint.setShader(null);

    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(density);
    paint.setColor(withAlpha(paperShade, 0.85f));
    rect.inset(density / 2f, density / 2f);
    canvas.drawRoundRect(rect, radius, radius, paint);
    rect.inset(-density / 2f, -density / 2f);

    paint.setColor(withAlpha(brand, 0.20f));
    float pad = 7f * density;
    float gap = 9f * density;
    for (float y = t + gap; y < b - gap * 0.4f; y += gap) {
      canvas.drawLine(l + pad, y, r - pad, y, paint);
    }

    canvas.restore();
  }

  private static float clamp01(float v) {
    return v < 0f ? 0f : (v > 1f ? 1f : v);
  }

  /** Smoothstep, matching the web loader's ease-in-out feel. */
  private static float ease(float t) {
    return t * t * (3f - 2f * t);
  }

  /** Blends {@code b} into {@code a} by {@code t}, per channel. */
  private static int mix(int a, int b, float t) {
    int r = Math.round(((a >> 16) & 0xFF) + (((b >> 16) & 0xFF) - ((a >> 16) & 0xFF)) * t);
    int g = Math.round(((a >> 8) & 0xFF) + (((b >> 8) & 0xFF) - ((a >> 8) & 0xFF)) * t);
    int bl = Math.round((a & 0xFF) + ((b & 0xFF) - (a & 0xFF)) * t);
    return 0xFF000000 | (r << 16) | (g << 8) | bl;
  }

  private static int withAlpha(int color, float alpha) {
    return (color & 0x00FFFFFF) | (Math.round(255 * Math.max(0f, Math.min(1f, alpha))) << 24);
  }
}
