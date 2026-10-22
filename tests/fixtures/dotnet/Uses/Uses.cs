namespace Uses;
public static class Gallery {
  public static Demo.Circle Biggest(Demo.Circle[] all) {
    Demo.Circle best = all[0];
    foreach (var circle in all) if (circle.Area() > best.Area()) best = circle;
    return best;
  }
  public static object Boxed(Demo.Circle circle) => (Demo.IShape)circle;
  public static double Unbox(object value) {
    var circle = (Demo.Circle)value;
    var made = new Demo.Circle(circle.Radius * 2);
    return made.Area();
  }
}
