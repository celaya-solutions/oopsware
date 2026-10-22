namespace Demo;
public interface IShape { double Area(); }
public sealed class Circle : IShape {
  public double Radius { get; }
  public Circle(double radius) { Radius = radius; }
  public double Area() => System.Math.PI * Radius * Radius;
  public class Unit { public static Circle Make() => new Circle(1); }
}
public static class Tools {
  public static int Sum(int[] values) { var total = 0; foreach (var v in values) total += v; return total; }
  public static string Describe(IShape s) => s switch { Circle c when c.Radius > 1 => "big", Circle => "circle", _ => "shape" };
}
public delegate double Scale(double value);
public record Point(int X, int Y) { public int Sum() => X + Y; }
