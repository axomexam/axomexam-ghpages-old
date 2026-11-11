package in.axomexam.app;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.provider.Settings;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.LinearInterpolator;

import androidx.core.content.ContextCompat;

/**
 * Book-opening loader: a closed book whose front cover swings open about the
 * spine, revealing the page underneath, then swings shut. This mirrors the web
 * loader (the {@code .axo-book} component) so the app and the site share one
 * waiting motif.
 *
 * The view drives its own animation — it starts when it becomes visible and
 * stops when hidden or detached — so callers only toggle visibility.
 */
public class BookLoaderView extends View {

  /* One open-and-shut cycle. The cover turns during the first 42%, holds open
     until 60%, then turns back — the same shape as the web keyframes. */
  private static final float OPEN_AT = 0.42f;
  private static final float HOLD_UNTIL = 0.60f;
  private static final long CYCLE_MS = 2800L;

  private static final float BOOK_W_DP = 108f;
  private static final float BOOK_H_DP = 74f;
  private static final float FLOAT_DP = 6f;
  private static final float RULE_GAP_DP = 10f;

  private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final RectF rect = new RectF();

  private final float density;
  private final int brand;
  private final int brandEnd;
  private final int card;
  private final int line;

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
    line = ContextCompat.getColor(context, R.color.line);
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
      progress = OPEN_AT; // show the book open and still
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

  /** Honours the system "remove animations" setting. */
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
    float h = BOOK_H_DP * density;
    float left = (getWidth() - w) / 2f;
    float top = (getHeight() - h) / 2f;
    float spine = left + w / 2f;
    float right = left + w;
    float bottom = top + h;

    // Gentle float, in phase with the web loader's axoBookFloat keyframe.
    float floatY = -FLOAT_DP * density * (float) Math.sin(Math.PI * progress);
    canvas.save();
    canvas.translate(0f, floatY);

    drawPage(canvas, spine, top, right, bottom);
    drawSpine(canvas, spine, top, bottom);
    drawCover(canvas, spine, top, right, bottom);

    canvas.restore();
  }

  /** The right-hand page the cover reveals, with faint ruled lines. */
  private void drawPage(Canvas canvas, float spine, float top, float right, float bottom) {
    float radius = 5f * density;
    rect.set(spine, top, right, bottom);
    paint.setStyle(Paint.Style.FILL);
    paint.setShader(null);
    paint.setColor(card);
    canvas.drawRoundRect(rect, radius, radius, paint);

    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(density);
    paint.setColor(line);
    rect.inset(density / 2f, density / 2f);
    canvas.drawRoundRect(rect, radius, radius, paint);

    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(density);
    paint.setColor(withAlpha(line, 0.75f));
    float gap = RULE_GAP_DP * density;
    float inset = 8f * density;
    for (float y = top + gap; y < bottom - gap * 0.4f; y += gap) {
      canvas.drawLine(spine + inset, y, right - inset, y, paint);
    }
  }

  private void drawSpine(Canvas canvas, float spine, float top, float bottom) {
    paint.setShader(null);
    paint.setStyle(Paint.Style.FILL);
    paint.setColor(line);
    rect.set(spine - density, top + 2f * density, spine + density, bottom - 2f * density);
    canvas.drawRoundRect(rect, density, density, paint);
  }

  /** The front cover, hinged at the spine, swinging open to the left. */
  private void drawCover(Canvas canvas, float spine, float top, float right, float bottom) {
    float radians = (float) Math.toRadians(coverAngle());
    float cos = (float) Math.cos(radians);

    // A touch of perspective: the far edge swells as the cover comes toward us.
    float half = (right - spine) / 2f;
    float depth = half * (float) Math.abs(Math.sin(radians));
    float focal = half * 6f;
    float persp = focal / (focal - depth);

    float cx = spine;
    float cy = (top + bottom) / 2f;

    canvas.save();
    canvas.translate(cx, cy);
    canvas.scale(cos * persp, persp);
    canvas.translate(-cx, -cy);

    float radius = 5f * density;
    rect.set(spine, top, right, bottom);
    paint.setStyle(Paint.Style.FILL);
    paint.setShader(new LinearGradient(spine, top, right, bottom, brand, brandEnd,
        Shader.TileMode.CLAMP));
    canvas.drawRoundRect(rect, radius, radius, paint);
    paint.setShader(null);

    canvas.restore();
  }

  /** Cover angle in degrees: 0 closed, -180 fully open, per the cycle. */
  private float coverAngle() {
    float p = progress;
    if (p <= OPEN_AT) {
      return -180f * ease(p / OPEN_AT);
    }
    if (p <= HOLD_UNTIL) {
      return -180f;
    }
    return -180f * (1f - ease((p - HOLD_UNTIL) / (1f - HOLD_UNTIL)));
  }

  /** Smoothstep, matching the web loader's ease-in-out feel. */
  private static float ease(float t) {
    t = Math.max(0f, Math.min(1f, t));
    return t * t * (3f - 2f * t);
  }

  private static int withAlpha(int color, float alpha) {
    return (color & 0x00FFFFFF) | (Math.round(255 * alpha) << 24);
  }
}
